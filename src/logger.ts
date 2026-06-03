const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export type LogLevel = keyof typeof LOG_LEVELS;

export class Logger {
  private level: number;

  constructor(level: LogLevel = "info") {
    this.level = LOG_LEVELS[level];
  }

  debug(...args: unknown[]): void {
    if (this.level <= 0) console.log("[debug]", ...args);
  }

  info(...args: unknown[]): void {
    if (this.level <= 1) console.log("[info]", ...args);
  }

  warn(...args: unknown[]): void {
    if (this.level <= 2) console.warn("[warn]", ...args);
  }

  error(...args: unknown[]): void {
    if (this.level <= 3) console.error("[error]", ...args);
  }
}

let instance: Logger | null = null;

export function initLogger(level: LogLevel): void {
  instance = new Logger(level);
}

export function getLogger(): Logger {
  if (!instance) instance = new Logger("info");
  return instance;
}
