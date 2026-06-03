import { spawn, type ChildProcess } from "node:child_process";
import type { Config } from "./config.js";

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexRunResult {
  sessionId?: string;
  text: string;
  usage?: CodexUsage;
  rawEvents: unknown[];
}

export interface CodexRunOptions {
  key: string;
  cwd: string;
  prompt: string;
  sessionId?: string;
  onText?: (delta: string) => void;
  onStatus?: (status: string) => void;
}

function pushIf(args: string[], flag: string, value?: string): void {
  if (value) args.push(flag, value);
}

function buildExecArgs(cfg: Config, opts: CodexRunOptions): string[] {
  const args: string[] = ["exec"];

  if (opts.sessionId) {
    args.push("resume");
  }

  args.push("--json");
  if (cfg.skipGitRepoCheck) args.push("--skip-git-repo-check");
  pushIf(args, "-m", cfg.codexModel);
  pushIf(args, "-p", cfg.codexProfile);
  pushIf(args, "-s", cfg.codexSandbox);
  pushIf(args, "-a", cfg.codexApproval);
  args.push(...cfg.codexExtraArgs);

  // New exec supports -C; resume reuses the session cwd and does not expose -C.
  if (!opts.sessionId) args.push("-C", opts.cwd);
  if (opts.sessionId) args.push(opts.sessionId);
  args.push(opts.prompt);
  return args;
}

function summarizeEvent(ev: any): string | null {
  if (!ev || typeof ev !== "object") return null;
  switch (ev.type) {
    case "thread.started":
      return `🧵 session ${String(ev.thread_id ?? "").slice(0, 8)}`;
    case "turn.started":
      return "🧠 Codex 开始思考…";
    case "turn.completed":
      return "✅ Codex turn 完成";
    case "item.started":
      return ev.item?.type ? `▶️ ${ev.item.type}` : "▶️ item started";
    case "item.completed":
      if (ev.item?.type === "tool_call") return `🔧 ${ev.item?.name ?? "tool"}`;
      if (ev.item?.type === "agent_message") return "✍️ 正在生成回复…";
      return ev.item?.type ? `✅ ${ev.item.type}` : null;
    default:
      return null;
  }
}

export class CodexRunner {
  private active = new Map<string, ChildProcess>();

  constructor(private readonly cfg: Config) {}

  abort(key: string): boolean {
    const child = this.active.get(key);
    if (!child) return false;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 3000).unref();
    return true;
  }

  async run(opts: CodexRunOptions): Promise<CodexRunResult> {
    const args = buildExecArgs(this.cfg, opts);
    opts.onStatus?.(`🚀 ${this.cfg.codexBin} ${args.slice(0, -1).join(" ")}`);

    return new Promise<CodexRunResult>((resolve, reject) => {
      const child = spawn(this.cfg.codexBin, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.set(opts.key, child);

      let stdoutBuf = "";
      let stderr = "";
      let text = "";
      let sessionId = opts.sessionId;
      let usage: CodexUsage | undefined;
      const rawEvents: unknown[] = [];
      let settled = false;
      let timedOut = false;

      const timeout = this.cfg.promptTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, this.cfg.promptTimeoutMs)
        : null;
      timeout?.unref();

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.active.delete(opts.key);
        if (err) reject(err);
        else resolve({ sessionId, text: text.trim(), usage, rawEvents });
      };

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: any;
        try {
          ev = JSON.parse(trimmed);
        } catch {
          opts.onText?.(`${trimmed}\n`);
          text += `${trimmed}\n`;
          return;
        }
        rawEvents.push(ev);
        if (ev.type === "thread.started" && ev.thread_id) sessionId = ev.thread_id;
        if (ev.type === "turn.completed" && ev.usage) usage = ev.usage;
        const status = summarizeEvent(ev);
        if (status) opts.onStatus?.(status);

        const item = ev.item;
        const chunk =
          ev.delta ??
          ev.text_delta ??
          (ev.type === "item.completed" && item?.type === "agent_message" ? item.text : undefined);
        if (typeof chunk === "string" && chunk) {
          text += chunk;
          opts.onText?.(chunk);
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        let idx: number;
        while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          handleLine(line);
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        const useful = chunk.trim();
        if (useful && !useful.includes("Reading additional input from stdin")) opts.onStatus?.(`⚠️ ${useful.slice(0, 160)}`);
      });

      child.on("error", (err) => finish(err));
      child.on("close", (code, signal) => {
        if (stdoutBuf.trim()) handleLine(stdoutBuf);
        if (timedOut) return finish(new Error(`Codex 请求超时 (${Math.round(this.cfg.promptTimeoutMs / 1000)}s)`));
        if (signal) return finish(new Error(`Codex 已中止 (${signal})`));
        if (code && code !== 0) return finish(new Error(`Codex 退出码 ${code}: ${stderr.trim() || "unknown error"}`));
        finish();
      });
    });
  }
}
