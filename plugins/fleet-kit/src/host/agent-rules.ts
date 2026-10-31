// The build's agent rules: a Markdown file Fleet Kit owns in the OpenCode
// configuration directory. opencode.json lists it in `instructions` (see
// opencode-config.ts), so OpenCode loads it after AGENTS.md files and reloads
// it when it changes. The person's own AGENTS.md is never touched.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { RULES_FILE } from "./opencode-config.js";

const HEADER = "<!-- Written by Fleet Kit from the build manifest; local edits are replaced on the next sync. -->";

export function rulesPath(directory: string): string {
  return join(directory, RULES_FILE);
}

export function rulesText(lines: string[]): string {
  return `${HEADER}\n${lines.join("\n").trimEnd()}\n`;
}

/** Write the rules file, or remove it when the build has no rules. Returns whether the file changed. */
export async function syncAgentRules(directory: string, lines: string[] | undefined): Promise<boolean> {
  const path = rulesPath(directory);
  let current: string | null = null;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} must be a regular file`);
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (lines === undefined) {
    if (current === null) return false;
    await unlink(path);
    return true;
  }
  const text = rulesText(lines);
  if (text === current) return false;
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o644);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return true;
}
