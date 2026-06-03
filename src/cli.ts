#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath, defaultWorkspaceDir, loadConfig, redactedConfig, type Config, type ConfigOverrides } from "./config.js";
import { startBridge } from "./bridge.js";

const FALLBACK_HELP = `# codex-feishu-bridge

Feishu/Lark bot bridge for Codex CLI.

## Source

GitHub: https://github.com/zxzhuo/codex-feishu-bridge

中文作者: 卓正兴

## Usage

  codex-feishu init [options]      create ~/.config/codex-feishu/config.json
  codex-feishu start               start bridge in background
  codex-feishu run                 run bridge in foreground
  codex-feishu stop                stop background bridge
  codex-feishu restart             restart background bridge
  codex-feishu status              show background bridge status
  codex-feishu logs [--lines N]    print recent bridge logs
  codex-feishu config              print resolved config with secrets redacted
  codex-feishu doctor              check config and Codex availability
  codex-feishu help                print this help/readme

## Init options

  --app-id <cli_xxx>               Feishu app id
  --app-secret <secret>            Feishu app secret (prefer --app-secret-env)
  --app-secret-env <ENV>           env var name containing secret, default FEISHU_APP_SECRET
  --owner-open-id <ou_xxx>         restrict bot to owner open_id; repeatable or comma-separated
  --workspace-dir <dir>            workspace/project root, default ~
  --projects-dir <dir>             alias of --workspace-dir, kept for compatibility
  --state-dir <dir>                runtime state/log/pid directory, default ~/.codex-feishu
  --default-project <name>         default project, default . (workspace root)
  --codex-bin <path>               codex executable, default codex
  --transport <ws|http|both>       Feishu transport, default ws
  --no-owner-only                  allow all users who @bot / DM bot

## Example

  FEISHU_APP_SECRET=xxx codex-feishu init --app-id cli_xxx --app-secret-env FEISHU_APP_SECRET --owner-open-id ou_xxx
  codex-feishu start
`;

function readFullHelp(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "README.md"),
    path.resolve(process.cwd(), "README.md"),
  ];
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      // try next candidate
    }
  }
  return FALLBACK_HELP;
}

export function printHelp(): void {
  console.log(readFullHelp());
}

function printErrorWithHelp(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[codex-feishu] ${message}\n\n`);
  process.stderr.write(`${readFullHelp()}\n`);
}

function take(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const val = args[idx + 1];
  if (!val || val.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(idx, 2);
  return val;
}

function has(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx < 0) return false;
  args.splice(idx, 1);
  return true;
}

function collect(args: string[], name: string): string[] {
  const out: string[] = [];
  for (;;) {
    const val = take(args, name);
    if (!val) break;
    out.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

function runtimeOverrides(args: string[]): ConfigOverrides {
  return {
    workspaceDir: take(args, "--workspace-dir") ?? take(args, "--projects-dir"),
    stateDir: take(args, "--state-dir"),
    defaultProject: take(args, "--default-project"),
  };
}

function applyOverridesToEnv(env: NodeJS.ProcessEnv, cfg: Config, overrides: ConfigOverrides): NodeJS.ProcessEnv {
  const next = { ...env };
  if (overrides.workspaceDir || overrides.projectsBaseDir) next.CODEX_FEISHU_WORKSPACE_DIR = cfg.projectsBaseDir;
  if (overrides.stateDir) next.CODEX_FEISHU_STATE_DIR = cfg.stateDir;
  if (overrides.defaultProject) next.CODEX_FEISHU_DEFAULT_PROJECT = cfg.defaultProject;
  return next;
}

async function init(args: string[]): Promise<void> {
  const configPath = take(args, "--config") ?? defaultConfigPath();
  const appId = take(args, "--app-id") ?? process.env.FEISHU_APP_ID;
  const appSecret = take(args, "--app-secret");
  const appSecretEnv = take(args, "--app-secret-env") ?? (appSecret ? undefined : "FEISHU_APP_SECRET");
  const owners = collect(args, "--owner-open-id");
  const projectsBaseDir = take(args, "--workspace-dir") ?? take(args, "--projects-dir") ?? defaultWorkspaceDir();
  const defaultProject = take(args, "--default-project") ?? ".";
  const codexBin = take(args, "--codex-bin") ?? "codex";
  const transport = take(args, "--transport") ?? "ws";
  const ownerOnly = !has(args, "--no-owner-only");

  if (!appId) throw new Error("missing --app-id or FEISHU_APP_ID");
  if (!appSecret && appSecretEnv && !process.env[appSecretEnv]) {
    console.warn(`[warn] ${appSecretEnv} is not set now. Config will reference it; set it before running.`);
  }
  if (!appSecret && !appSecretEnv) throw new Error("missing --app-secret or --app-secret-env");
  if (!["ws", "http", "both"].includes(transport)) throw new Error("--transport must be ws, http, or both");

  const cfg: Record<string, unknown> = {
    appId,
    transport,
    allowedOpenIds: owners,
    ownerOnly,
    workspaceDir: projectsBaseDir,
    stateDir: path.join(os.homedir(), ".codex-feishu"),
    defaultProject,
    codexBin,
    skipGitRepoCheck: true,
    promptTimeoutMs: 0,
    streamFlushMs: 1200,
    maxReplyChars: 24000,
    logLevel: "info",
  };
  if (appSecret) cfg.appSecret = appSecret;
  else cfg.appSecret = `\${${appSecretEnv}}`;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  fs.mkdirSync(projectsBaseDir, { recursive: true });
  fs.mkdirSync(path.join(projectsBaseDir, defaultProject), { recursive: true });
  console.log(`✅ wrote ${configPath}`);
  console.log(`✅ ensured project ${path.join(projectsBaseDir, defaultProject)}`);
  console.log("Next: codex-feishu start");
}

async function doctor(args: string[]): Promise<void> {
  const cfg = loadConfig(runtimeOverrides(args));
  console.log(JSON.stringify(redactedConfig(cfg), null, 2));
  const res = spawnSync(cfg.codexBin, ["--version"], { encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(res.stderr || `codex exited ${res.status}`);
  console.log(`✅ Codex: ${res.stdout.trim()}`);
}

function daemonPaths(cfg: Config): { pidFile: string; logFile: string } {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  return {
    pidFile: path.join(cfg.stateDir, "codex-feishu.pid"),
    logFile: path.join(cfg.stateDir, "codex-feishu.log"),
  };
}

function readPid(pidFile: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startDaemon(args: string[]): Promise<void> {
  const overrides = runtimeOverrides(args);
  const cfg = loadConfig(overrides);
  const { pidFile, logFile } = daemonPaths(cfg);
  const oldPid = readPid(pidFile);
  if (oldPid && isProcessAlive(oldPid)) {
    console.log(`codex-feishu is already running: pid=${oldPid}`);
    console.log(`log: ${logFile}`);
    return;
  }

  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [process.argv[1] ?? "", "run"], {
    cwd: process.cwd(),
    env: applyOverridesToEnv(process.env, cfg, overrides),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  fs.closeSync(logFd);
  console.log(`✅ codex-feishu started in background: pid=${child.pid}`);
  console.log(`pid: ${pidFile}`);
  console.log(`log: ${logFile}`);
}

async function stopDaemon(args: string[]): Promise<void> {
  const cfg = loadConfig(runtimeOverrides(args));
  const { pidFile, logFile } = daemonPaths(cfg);
  const pid = readPid(pidFile);
  if (!pid || !isProcessAlive(pid)) {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    console.log("codex-feishu is not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    if (!isProcessAlive(pid)) break;
  }
  if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  console.log(`✅ stopped codex-feishu pid=${pid}`);
  console.log(`log: ${logFile}`);
}

async function restartDaemon(args: string[]): Promise<void> {
  await stopDaemon([...args]);
  await startDaemon(args);
}

function statusDaemon(args: string[]): void {
  const cfg = loadConfig(runtimeOverrides(args));
  const { pidFile, logFile } = daemonPaths(cfg);
  const pid = readPid(pidFile);
  if (pid && isProcessAlive(pid)) console.log(`✅ codex-feishu running: pid=${pid}`);
  else console.log("codex-feishu is not running");
  console.log(`pid: ${pidFile}`);
  console.log(`log: ${logFile}`);
}

function logsDaemon(args: string[]): void {
  const cfg = loadConfig(runtimeOverrides(args));
  const { logFile } = daemonPaths(cfg);
  const lines = Number(take(args, "--lines") ?? "80");
  if (!fs.existsSync(logFile)) {
    console.log(`no log file: ${logFile}`);
    return;
  }
  const res = spawnSync("tail", ["-n", String(Number.isFinite(lines) && lines > 0 ? lines : 80), logFile], { encoding: "utf8" });
  if (res.error) throw res.error;
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
}

async function run(args: string[]): Promise<void> {
  const cfg = loadConfig(runtimeOverrides(args));
  const shutdownFn = await startBridge(cfg);
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\n[codex-feishu] received ${signal}, shutting down…\n`);
    await shutdownFn().catch((err) => process.stderr.write(`[codex-feishu] shutdown error: ${err?.message ?? err}\n`));
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const cmd = argv.shift() ?? "help";
    if (cmd === "help" || cmd === "--help" || cmd === "-h") return printHelp();
    if (cmd === "init") return init(argv);
    if (cmd === "start") return startDaemon(argv);
    if (cmd === "run") return run(argv);
    if (cmd === "stop") return stopDaemon(argv);
    if (cmd === "restart") return restartDaemon(argv);
    if (cmd === "status") return statusDaemon(argv);
    if (cmd === "logs") return logsDaemon(argv);
    if (cmd === "doctor") return doctor(argv);
    if (cmd === "config") {
      console.log(JSON.stringify(redactedConfig(loadConfig(runtimeOverrides(argv))), null, 2));
      return;
    }
    throw new Error(`unknown command: ${cmd}`);
  } catch (err) {
    printErrorWithHelp(err);
    process.exitCode = 1;
  }
}
