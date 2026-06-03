import { spawn } from "node:child_process";
import { createFeishuService, type FeishuMessageContext } from "feishu-agent-bridge";
import type { Config } from "./config.js";
import { CardController, sendText } from "./card.js";
import { ChatQueue } from "./chat-queue.js";
import { CodexRunner, type CodexUsage } from "./codex.js";
import { DedupCache } from "./dedup.js";
import { getLogger, initLogger } from "./logger.js";
import { ensureProject, listProjects, projectExists } from "./projects.js";
import { BridgeState, type SessionRecord } from "./state.js";

interface ParsedCommand {
  cmd: string;
  args: string;
}

const BUILTIN_COMMANDS = new Set([
  "help", "h",
  "status",
  "project", "projects",
  "new",
  "compact",
  "sessions",
  "abort", "stop",
  "codex",
]);

function parseSlashCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const idx = t.indexOf(" ");
  if (idx < 0) return { cmd: t.slice(1).toLowerCase(), args: "" };
  return { cmd: t.slice(1, idx).toLowerCase(), args: t.slice(idx + 1).trim() };
}

function isAbortTrigger(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[\s.!?,:;。！？]+$/u, "");
  return ["stop", "abort", "cancel", "interrupt", "halt", "停", "停止", "取消", "中断", "等等"].includes(t);
}

function shortId(id?: string): string {
  if (!id) return "-";
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatSessionLine(s: SessionRecord, i: number): string {
  return `${i + 1}. ${shortId(s.sessionId)}  📁 ${s.project}  ${new Date(s.updatedAt).toLocaleString()}\n   ${s.lastPrompt?.slice(0, 80) ?? ""}`;
}

function splitWords(input: string): string[] {
  return input.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

const COMPACT_PROMPT = `Please compact the current Codex session context for future continuation.

Return a concise but complete handoff note in English. Include:
- Current goal and user intent
- Relevant repository, workspace, and file paths
- Completed changes and important decisions
- Pending work, risks, and next steps
- Commands, tests, configuration values, and constraints that matter
- Any session state needed to resume safely

Do not edit files or run shell commands. Do not include secrets, tokens, passwords, or credentials. The output must be useful as the only prior context for a fresh continuation session.`;

function buildCompactSeedPrompt(summary: string): string {
  return `You are initializing a fresh Codex continuation session from a compacted context.

Treat the following compacted context as the complete prior context for future work. Do not edit files, run shell commands, or start implementation now. Reply with one short acknowledgement only.

<COMPACTED_CONTEXT>
${summary}
</COMPACTED_CONTEXT>`;
}

function combineUsage(...usages: Array<CodexUsage | undefined>): CodexUsage | undefined {
  const out: CodexUsage = {};
  for (const usage of usages) {
    if (!usage) continue;
    out.input_tokens = (out.input_tokens ?? 0) + (usage.input_tokens ?? 0);
    out.cached_input_tokens = (out.cached_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
    out.output_tokens = (out.output_tokens ?? 0) + (usage.output_tokens ?? 0);
    out.reasoning_output_tokens = (out.reasoning_output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function runCommand(command: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function manageCodex(cfg: Config, action: string): Promise<string> {
  const map: Record<string, string[]> = {
    "remote-start": ["remote-control", "start"],
    "remote-stop": ["remote-control", "stop"],
    "daemon-start": ["app-server", "daemon", "start"],
    "daemon-stop": ["app-server", "daemon", "stop"],
    "doctor": ["doctor"],
    "version": ["--version"],
  };
  const args = map[action];
  if (!args) {
    return "用法: /codex remote-start | remote-stop | daemon-start | daemon-stop | doctor | version";
  }
  const res = await runCommand(cfg.codexBin, args, action === "doctor" ? 120_000 : 30_000);
  const out = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n").trim();
  const prefix = res.code === 0 ? "✅" : "❌";
  return `${prefix} codex ${args.join(" ")}\n\n${out || `(exit ${res.code})`}`;
}

async function handleCommand(
  parsed: ParsedCommand,
  cfg: Config,
  state: BridgeState,
  runner: CodexRunner,
  chatId: string,
): Promise<string | null> {
  const { cmd, args } = parsed;
  const currentProject = state.getActiveProject(chatId, cfg.defaultProject);

  if (cmd === "help" || cmd === "h") {
    return [
      "**Codex Feishu Bridge 命令**",
      "",
      "*会话 / 项目*",
      "/status — 当前项目、Codex session、配置状态",
      "/project — 列出项目",
      "/project <name> — 切换项目（项目目录已存在时）",
      "/project new <name> — 创建并切换项目",
      "/new — 清空当前项目绑定的 Codex session，下条消息新开 session",
      "/compact — 用英文压缩当前 Codex session，并切换到新的轻量 continuation session",
      "/sessions — 列出本 bridge 记录的 Codex sessions",
      "/abort — 中止当前 chat+project 正在运行的 Codex",
      "",
      "*Codex 本机管理*",
      "/codex remote-start — 启动 remote-control app-server daemon",
      "/codex remote-stop — 停止 remote-control daemon",
      "/codex daemon-start — 启动普通 app-server daemon",
      "/codex daemon-stop — 停止 app-server daemon",
      "/codex doctor — 运行 codex doctor",
      "/codex version — 查看 Codex 版本",
      "",
      "普通消息会发送给 Codex；同一 chat+project 自动 resume 上次 session。",
    ].join("\n");
  }

  if (cmd === "status") {
    const session = state.getSession(chatId, currentProject);
    const cwd = ensureProject(cfg.projectsBaseDir, currentProject);
    return [
      "**Codex Bridge 状态**",
      `项目: ${currentProject}`,
      `目录: ${cwd}`,
      `session: ${session ? session.sessionId : "(无，下条消息新建)"}`,
      `Codex: ${cfg.codexBin}`,
      `state: ${state.stateFile}`,
    ].join("\n");
  }

  if (cmd === "project" || cmd === "projects") {
    const projectArg = args.trim();
    if (!projectArg) {
      const projects = listProjects(cfg.projectsBaseDir);
      if (projects.length === 0) return "没有项目。用 `/project new <name>` 创建。";
      return `**项目列表**\n${projects.map((p) => `${p === currentProject ? "▶" : " "} ${p}`).join("\n")}`;
    }
    if (/^new(?:\s+|$)/u.test(projectArg)) {
      const name = projectArg.replace(/^new\s*/u, "");
      if (!name) return "用法: /project new <name>";
      const dir = ensureProject(cfg.projectsBaseDir, name);
      state.setActiveProject(chatId, name);
      return `✅ 已创建并切换到项目 ${name}\n${dir}`;
    }
    const name = projectArg;
    if (!projectExists(cfg.projectsBaseDir, name)) return `❌ 项目 ${name} 不存在。用 /project new ${name} 创建。`;
    state.setActiveProject(chatId, name);
    return `✅ 已切换到项目 ${name}`;
  }

  if (cmd === "new") {
    state.clearSession(chatId, currentProject);
    return `🆕 已清空项目 ${currentProject} 的 Codex session，下条消息会新建。`;
  }

  if (cmd === "sessions") {
    const sessions = state.listSessions(chatId).slice(0, 10);
    if (sessions.length === 0) return "（暂无 Codex session 记录）";
    return `**最近 Codex sessions**\n${sessions.map(formatSessionLine).join("\n")}`;
  }

  if (cmd === "abort" || cmd === "stop") {
    const key = `${chatId}::${currentProject}`;
    return runner.abort(key) ? "⛔ 已请求中止当前 Codex" : "当前没有正在运行的 Codex";
  }

  if (cmd === "codex") {
    return manageCodex(cfg, splitWords(args)[0] ?? "");
  }

  if (BUILTIN_COMMANDS.has(cmd)) return null;
  return `❌ 未知命令: /${cmd}\n用 /help 查看可用命令。`;
}

async function compactSession(opts: {
  client: any;
  cfg: Config;
  state: BridgeState;
  runner: CodexRunner;
  chatId: string;
  project: string;
  key: string;
}): Promise<void> {
  const { client, cfg, state, runner, chatId, project, key } = opts;
  const previous = state.getSession(chatId, project);
  if (!previous?.sessionId) {
    await sendText(client, chatId, `当前项目 ${project} 还没有可压缩的 Codex session。先发一条普通消息创建 session。`);
    return;
  }

  const cwd = ensureProject(cfg.projectsBaseDir, project);
  const ctrl = new CardController(client, chatId, cfg.streamFlushMs, cfg.maxReplyChars);
  const startAt = Date.now();
  await ctrl.start(`🧹 正在压缩 Codex context · 📁 ${project}`);

  try {
    const compactResult = await runner.run({
      key,
      cwd,
      prompt: COMPACT_PROMPT,
      sessionId: previous.sessionId,
      onText: (delta) => ctrl.append(delta),
      onStatus: (status) => ctrl.setStatus(status),
    });
    const summary = compactResult.text.trim();
    if (!summary) throw new Error("Codex did not return a compacted summary");

    ctrl.setStatus("🌱 正在创建新的轻量 continuation session…");
    const seedResult = await runner.run({
      key,
      cwd,
      prompt: buildCompactSeedPrompt(summary),
      onStatus: (status) => ctrl.setStatus(status),
    });

    const nextSessionId = seedResult.sessionId ?? compactResult.sessionId ?? previous.sessionId;
    state.setSession({
      sessionId: nextSessionId,
      chatId,
      project,
      cwd,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastPrompt: "/compact",
      lastSummary: summary.slice(0, 200),
    });

    const usage = combineUsage(compactResult.usage, seedResult.usage);
    ctrl.append(`\n\n---\n\nCompacted continuation session: ${shortId(nextSessionId)}\n`);
    await ctrl.finalize({
      metrics: {
        sessionId: nextSessionId,
        project,
        cwd,
        elapsedMs: Date.now() - startAt,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cachedInputTokens: usage?.cached_input_tokens,
      },
    });
  } catch (e: any) {
    ctrl.append(`\n\n❌ ${e?.message ?? String(e)}`);
    await ctrl.finalize({ isError: true, metrics: { sessionId: previous.sessionId, project, cwd, elapsedMs: Date.now() - startAt } });
  }
}

export async function startBridge(cfg: Config): Promise<() => Promise<void>> {
  initLogger(cfg.logLevel);
  const log = getLogger();
  ensureProject(cfg.projectsBaseDir, cfg.defaultProject);

  const dedup = new DedupCache(5000, cfg.dedupTtlMs);
  const queue = new ChatQueue();
  const state = new BridgeState(cfg.stateDir);
  const runner = new CodexRunner(cfg);

  const service = await createFeishuService({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    transport: cfg.transport,
    log: (level, message, extra) => {
      log[level]?.(`[feishu] ${message}`, extra ?? "");
    },
    onMessage: async (msg: FeishuMessageContext) => {
      const receivedAt = Date.now();
      const msgTail = msg.messageId.slice(-8);
      log.info(`[bridge] receive msg=${msgTail} sender=${msg.senderId.slice(-8)} shouldReply=${msg.shouldReply}`);

      if (!dedup.check(msg.messageId)) {
        log.info(`[bridge] skip duplicate msg=${msgTail}`);
        return;
      }
      if (cfg.ownerOnly && cfg.allowedOpenIds.length > 0 && !cfg.allowedOpenIds.includes(msg.senderId)) {
        log.warn(`[bridge] skip non-owner msg=${msgTail} sender=${msg.senderId} allowed=${cfg.allowedOpenIds.join(",")}`);
        return;
      }
      if (!msg.shouldReply) {
        log.info(`[bridge] skip shouldReply=false msg=${msgTail} chatType=${msg.chatType} content=${JSON.stringify(msg.content.slice(0, 80))}`);
        return;
      }

      const client = service.getClient();
      const project = state.getActiveProject(msg.chatId, cfg.defaultProject);
      const key = `${msg.chatId}::${project}`;
      const parsed = parseSlashCommand(msg.content);
      const queuedAhead = queue.depth(key);

      await queue.enqueue(key, async () => {
        if (isAbortTrigger(msg.content)) {
          const aborted = runner.abort(key);
          await sendText(client, msg.chatId, aborted ? "⛔ 已请求中止当前 Codex" : "当前没有正在运行的 Codex");
          return;
        }

        if (parsed) {
          if (parsed.cmd === "compact") {
            await compactSession({ client, cfg, state, runner, chatId: msg.chatId, project, key });
            return;
          }
          const result = await handleCommand(parsed, cfg, state, runner, msg.chatId);
          if (result !== null) await sendText(client, msg.chatId, result);
          return;
        }

        const cwd = ensureProject(cfg.projectsBaseDir, project);
        const previous = state.getSession(msg.chatId, project);
        const ctrl = new CardController(client, msg.chatId, cfg.streamFlushMs, cfg.maxReplyChars);
        await ctrl.start(
          queuedAhead > 0
            ? `⏳ 排队完成，开始处理 · 前面 ${queuedAhead} 个 · 📁 ${project}`
            : `🚀 正在调用 Codex · 📁 ${project}`
        );

        const startAt = Date.now();
        try {
          const result = await runner.run({
            key,
            cwd,
            prompt: msg.content,
            sessionId: previous?.sessionId,
            onText: (delta) => ctrl.append(delta),
            onStatus: (status) => ctrl.setStatus(status),
          });

          if (result.sessionId) {
            state.setSession({
              sessionId: result.sessionId,
              chatId: msg.chatId,
              project,
              cwd,
              createdAt: previous?.createdAt ?? nowIso(),
              updatedAt: nowIso(),
              lastPrompt: msg.content,
              lastSummary: result.text.slice(0, 200),
            });
          }

          await ctrl.finalize({
            metrics: {
              sessionId: result.sessionId ?? previous?.sessionId,
              project,
              cwd,
              elapsedMs: Date.now() - startAt,
              inputTokens: result.usage?.input_tokens,
              outputTokens: result.usage?.output_tokens,
              cachedInputTokens: result.usage?.cached_input_tokens,
            },
          });
        } catch (e: any) {
          ctrl.append(`\n\n❌ ${e?.message ?? String(e)}`);
          await ctrl.finalize({ isError: true, metrics: { sessionId: previous?.sessionId, project, cwd, elapsedMs: Date.now() - startAt } });
        }
      }).catch((err) => {
        log.error(`[bridge] queue error msg=${msgTail}:`, err);
      });

      log.debug(`[bridge] accepted msg=${msgTail} t+${Date.now() - receivedAt}ms`);
    },
  });

  service.run().catch((e) => log.error("[codex-feishu] service error:", e));

  return async () => {
    await service.shutdown();
  };
}
