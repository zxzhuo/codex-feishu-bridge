import fs from "node:fs";
import path from "node:path";

const SAFE_PROJECT_RE = /^[A-Za-z0-9._-]+$/;

export function assertSafeProjectName(name: string): void {
  if (!name || !SAFE_PROJECT_RE.test(name) || name === "..") {
    throw new Error("项目名只能包含字母、数字、点、下划线和横线；'.' 表示 workspace 本身");
  }
}

export function projectDir(baseDir: string, project: string): string {
  assertSafeProjectName(project);
  return path.join(baseDir, project);
}

export function ensureProject(baseDir: string, project: string): string {
  const dir = projectDir(baseDir, project);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectExists(baseDir: string, project: string): boolean {
  try {
    return fs.statSync(projectDir(baseDir, project)).isDirectory();
  } catch {
    return false;
  }
}

export function listProjects(baseDir: string): string[] {
  try {
    return fs.readdirSync(baseDir)
      .filter((name) => {
        if (name.startsWith(".")) return false;
        try {
          return fs.statSync(path.join(baseDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
