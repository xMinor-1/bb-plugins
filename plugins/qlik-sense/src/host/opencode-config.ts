// Called on the agent's host only. This module owns one MCP entry, never provider policy.
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applyEdits, modify, parseTree, type ParseError, findNodeAtLocation } from "jsonc-parser";
import { acquireConfigLock, type LockOptions } from "./config-lock.js";
import { resolveOpenCodeLocation, type OpenCodeLocationOptions } from "./opencode-location.js";

export const MCP_NAME = "qlik-sense";
export type OpenCodeMajor = 1 | 2;
export type LocalMcpEntry = {
  type: "local";
  command: string[];
  enabled: boolean;
};

/** High-level writer: use the same directory resolution as the model check. */
export async function writeQlikMcpConfig(options: OpenCodeLocationOptions & LockOptions & { major: OpenCodeMajor; entry: LocalMcpEntry }) {
  const location = resolveOpenCodeLocation(options);
  return await writeMcpConfig(location.configFile, options.major, options.entry, options);
}

export function openCodeMajor(versionOutput: string): OpenCodeMajor {
  const match = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(versionOutput.trim());
  if (!match) throw new Error("Unsupported OpenCode version; run opencode --version.");
  return Number(match[1]) as OpenCodeMajor;
}

function entryPath(major: OpenCodeMajor): string[] {
  return major === 2 ? ["mcp", "servers", MCP_NAME] : ["mcp", MCP_NAME];
}

export function patchMcpConfig(source: string, major: OpenCodeMajor, entry: LocalMcpEntry): { text: string; legacyEntry: boolean } {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || tree?.type !== "object") throw new Error("OpenCode configuration must be a valid JSON or JSONC object.");
  // Refuse duplicate keys: different parsers can otherwise disagree about which entry is active.
  const walk = (node: NonNullable<typeof tree>): void => {
    if (node.type === "object") {
      const keys = (node.children ?? []).map((property) => property.children?.[0]?.value);
      if (new Set(keys).size !== keys.length) throw new Error("OpenCode configuration contains duplicate keys.");
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  const path = entryPath(major);
  for (let i = 1; i < path.length; i++) {
    const parent = findNodeAtLocation(tree, path.slice(0, i));
    if (parent && parent.type !== "object") throw new Error("OpenCode MCP configuration must be an object.");
  }
  const text = applyEdits(source, modify(source, path, entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" },
  }));
  return { text, legacyEntry: !!findNodeAtLocation(tree, ["mcp", "qlik"]) };
}

/** Backup once, preserve unrelated JSONC text, and replace from the same directory. */
export async function writeMcpConfig(path: string, major: OpenCodeMajor, entry: LocalMcpEntry, options: LockOptions = {}) {
  if (!isAbsolute(path)) throw new Error("An absolute OpenCode configuration path is required.");
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const release = await acquireConfigLock(path, "qlik-sense", options);
    try {
      const result = await writeOnce(path, major, entry, options.signal);
      if (result !== null) return result;
    } finally { await release(); }
  }
  throw new Error("OpenCode configuration keeps changing. Try again when other writers finish.");
}

const hash = (text: string | null) => text === null ? null : createHash("sha256").update(text).digest("hex");

async function writeOnce(path: string, major: OpenCodeMajor, entry: LocalMcpEntry, signal?: AbortSignal) {
  const temporary = `${path}.qlik-sense-${randomUUID()}.tmp`;
  const backup = `${path}.before-qlik-sense.bak`;
  try {
    let original: string | null = null;
    let mode = 0o600;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("OpenCode configuration must be a regular file.");
      mode = stat.mode & 0o777;
      original = await readFile(path, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const result = patchMcpConfig(original ?? "{}\n", major, entry);
    if (result.text === original) return { changed: false, legacyEntry: result.legacyEntry, backup: null };
    const file = await open(temporary, "wx", mode);
    try { await file.writeFile(result.text, "utf8"); await file.sync(); } finally { await file.close(); }
    if (original !== null) {
      try {
        const backupFile = await open(backup, "wx", 0o600);
        try { await backupFile.writeFile(original, "utf8"); await backupFile.sync(); } finally { await backupFile.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    signal?.throwIfAborted();
    const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (hash(current) !== hash(original)) return null;
    await rename(temporary, path);
    return { changed: true, legacyEntry: result.legacyEntry, backup: original === null ? null : backup };
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
