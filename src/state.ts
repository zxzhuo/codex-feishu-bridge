import fs from "node:fs";
import path from "node:path";

export interface SessionRecord {
  sessionId: string;
  chatId: string;
  project: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  lastPrompt?: string;
  lastSummary?: string;
}

interface StateFile {
  activeProjects: Record<string, string>;
  sessions: Record<string, SessionRecord>;
}

function emptyState(): StateFile {
  return { activeProjects: {}, sessions: {} };
}

function routeKey(chatId: string, project: string): string {
  return `${chatId}::${project}`;
}

export class BridgeState {
  private state: StateFile = emptyState();
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "state.json");
    fs.mkdirSync(stateDir, { recursive: true });
    this.load();
  }

  get stateFile(): string {
    return this.file;
  }

  load(): void {
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8")) as StateFile;
      this.state.activeProjects ??= {};
      this.state.sessions ??= {};
    } catch {
      this.state = emptyState();
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  getActiveProject(chatId: string, defaultProject: string): string {
    const project = this.state.activeProjects[chatId] || defaultProject;
    this.state.activeProjects[chatId] = project;
    return project;
  }

  setActiveProject(chatId: string, project: string): void {
    this.state.activeProjects[chatId] = project;
    this.save();
  }

  getSession(chatId: string, project: string): SessionRecord | undefined {
    return this.state.sessions[routeKey(chatId, project)];
  }

  setSession(record: SessionRecord): void {
    this.state.sessions[routeKey(record.chatId, record.project)] = record;
    this.save();
  }

  clearSession(chatId: string, project: string): void {
    delete this.state.sessions[routeKey(chatId, project)];
    this.save();
  }

  listSessions(chatId?: string): SessionRecord[] {
    const all = Object.values(this.state.sessions);
    const filtered = chatId ? all.filter((s) => s.chatId === chatId) : all;
    return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
