import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LogLevel } from "./logger.js";

export interface Config {
  appId: string;
  appSecret: string;
  transport: "ws" | "http" | "both";
  allowedOpenIds: string[];
  ownerOnly: boolean;
  projectsBaseDir: string;
  stateDir: string;
  defaultProject: string;
  codexBin: string;
  codexModel?: string;
  codexProfile?: string;
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  codexApproval?: "untrusted" | "on-failure" | "on-request" | "never";
  codexExtraArgs: string[];
  skipGitRepoCheck: boolean;
  promptTimeoutMs: number;
  dedupTtlMs: number;
  streamFlushMs: number;
  maxReplyChars: number;
  logLevel: LogLevel;
}

type FileConfig = Partial<Config & { appSecretEnv: string }>;

const CONFIG_PATHS = [
  process.env.CODEX_FEISHU_CONFIG,
  path.join(os.homedir(), ".config", "codex-feishu", "config.json"),
].filter(Boolean) as string[];

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "codex-feishu", "config.json");
}

function expandEnv(val: string): string {
  return val.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] ?? "");
}

function expandHome(val: string): string {
  if (val === "~") return os.homedir();
  if (val.startsWith("~/")) return path.join(os.homedir(), val.slice(2));
  return val;
}

function loadFile(): FileConfig {
  for (const p of CONFIG_PATHS) {
    try {
      const raw = fs.readFileSync(expandHome(p), "utf8");
      const obj = JSON.parse(raw) as FileConfig;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") (obj as Record<string, unknown>)[k] = expandHome(expandEnv(v));
      }
      return obj;
    } catch {
      // try next
    }
  }
  return {};
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  const file = loadFile();
  const secretFromEnvName = file.appSecretEnv ? process.env[file.appSecretEnv] : undefined;
  const appId = process.env.FEISHU_APP_ID ?? file.appId ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET ?? secretFromEnvName ?? file.appSecret ?? "";

  if (!appId || !appSecret) {
    throw new Error(
      "codex-feishu: appId/appSecret missing. Run `codex-feishu init ...`, set ~/.config/codex-feishu/config.json, or set FEISHU_APP_ID/FEISHU_APP_SECRET."
    );
  }

  return {
    appId,
    appSecret,
    transport: (process.env.FEISHU_TRANSPORT as Config["transport"]) ?? file.transport ?? "ws",
    allowedOpenIds: parseCsv(process.env.CODEX_FEISHU_ALLOWED_OPEN_IDS) ?? file.allowedOpenIds ?? [],
    ownerOnly: process.env.CODEX_FEISHU_OWNER_ONLY
      ? process.env.CODEX_FEISHU_OWNER_ONLY === "1" || process.env.CODEX_FEISHU_OWNER_ONLY === "true"
      : file.ownerOnly ?? true,
    projectsBaseDir:
      process.env.CODEX_FEISHU_PROJECTS_DIR ??
      file.projectsBaseDir ??
      path.join(os.homedir(), "workplace", "projects"),
    stateDir: process.env.CODEX_FEISHU_STATE_DIR ?? file.stateDir ?? path.join(os.homedir(), ".codex-feishu"),
    defaultProject: process.env.CODEX_FEISHU_DEFAULT_PROJECT ?? file.defaultProject ?? "default",
    codexBin: process.env.CODEX_BIN ?? file.codexBin ?? "codex",
    codexModel: process.env.CODEX_MODEL ?? file.codexModel,
    codexProfile: process.env.CODEX_PROFILE ?? file.codexProfile,
    codexSandbox: (process.env.CODEX_SANDBOX as Config["codexSandbox"]) ?? file.codexSandbox,
    codexApproval: (process.env.CODEX_APPROVAL as Config["codexApproval"]) ?? file.codexApproval,
    codexExtraArgs: parseCsv(process.env.CODEX_FEISHU_CODEX_EXTRA_ARGS) ?? file.codexExtraArgs ?? [],
    skipGitRepoCheck: process.env.CODEX_SKIP_GIT_REPO_CHECK
      ? process.env.CODEX_SKIP_GIT_REPO_CHECK !== "0" && process.env.CODEX_SKIP_GIT_REPO_CHECK !== "false"
      : file.skipGitRepoCheck ?? true,
    promptTimeoutMs: file.promptTimeoutMs ?? 0,
    dedupTtlMs: file.dedupTtlMs ?? 600_000,
    streamFlushMs: file.streamFlushMs ?? 1200,
    maxReplyChars: file.maxReplyChars ?? 24_000,
    logLevel: (process.env.CODEX_FEISHU_LOG_LEVEL as LogLevel) ?? file.logLevel ?? "info",
  };
}

export function redactedConfig(cfg: Config): Record<string, unknown> {
  return { ...cfg, appSecret: cfg.appSecret ? "***" : "" };
}
