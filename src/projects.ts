import fs from "node:fs";
import path from "node:path";

export function assertSafeProjectName(name: string): void {
  if (!name || name.trim() !== name) {
    throw new Error("项目名不能为空，且不能以空白字符开头或结尾");
  }
  if (name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("项目名不能是 '..'，也不能包含路径分隔符");
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
