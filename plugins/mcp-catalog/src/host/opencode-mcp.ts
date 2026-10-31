// MCP Catalog's share of OpenCode 2's opencode.json: `mcp.servers.<name>` for
// every server the person switched on, and nothing else. Everything outside
// `mcp` — Fleet Kit's providers, the user's settings, comments — stays byte for
// byte; inside `mcp` the user's own servers keep their values, though the
// formatter may re-indent them. A name this plugin did not write is never overwritten unless
// the person asked to replace it; then the old entry (also an OpenCode 1
// style `mcp.<name>`) is removed.
//
// Tokens are not in the file: a header reads `Bearer {file:<token file>}`,
// which OpenCode 2 replaces with the file's content when it loads the
// configuration (checked on 2.2.5). The token files are 0600 and are written
// before an entry points at them.
//
// Writes follow Fleet Kit's bb-config-lock protocol (config-lock.ts) and its
// write steps (plugins/fleet-kit/src/host/opencode-config.ts): lock, read,
// patch, temporary file, one backup of the original, re-read and compare,
// rename. A file that changed underneath is patched again, up to five times.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { applyEdits, findNodeAtLocation, modify, parseTree, type Node, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { acquireConfigLock, type LockOptions } from "./config-lock.js";

export const WRITER = "mcp-catalog";

export interface McpEntry {
  name: string;
  value: Record<string, unknown>;
}

export interface PatchResult {
  text: string;
  /** Names now written by this plugin. */
  owned: string[];
  /** Wanted names held by an entry this plugin did not write. */
  conflicts: string[];
}

export class ConfigFileError extends Error {}

function parseConfig(source: string): Node {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || tree?.type !== "object") throw new ConfigFileError("opencode.json must be a valid JSON or JSONC object");
  const walk = (node: Node): void => {
    if (node.type === "object") {
      const keys = (node.children ?? []).map((property) => property.children?.[0]?.value);
      if (new Set(keys).size !== keys.length) throw new ConfigFileError("opencode.json contains duplicate keys");
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return tree;
}

function nodeValue(node: Node): unknown {
  switch (node.type) {
    case "object": {
      const result: Record<string, unknown> = {};
      for (const property of node.children ?? []) {
        const [key, value] = property.children ?? [];
        if (key && value) result[String(key.value)] = nodeValue(value);
      }
      return result;
    }
    case "array":
      return (node.children ?? []).map(nodeValue);
    default:
      return node.value;
  }
}

/** Keys OpenCode reserves inside `mcp`; a legacy server can never be called this. */
const MCP_RESERVED = new Set(["servers", "timeout"]);
const serverPath = (name: string) => ["mcp", "servers", name];
const legacyPath = (name: string) => ["mcp", name];

/** Names under `mcp` that hold a server, in either form. */
export function serverNamesIn(source: string): Set<string> {
  const tree = parseConfig(source);
  const names = new Set<string>();
  const mcp = findNodeAtLocation(tree, ["mcp"]);
  if (mcp?.type !== "object") return names;
  for (const property of mcp.children ?? []) {
    const key = String(property.children?.[0]?.value ?? "");
    if (!MCP_RESERVED.has(key)) names.add(key);
  }
  const servers = findNodeAtLocation(tree, ["mcp", "servers"]);
  if (servers?.type === "object") for (const property of servers.children ?? []) names.add(String(property.children?.[0]?.value ?? ""));
  return names;
}

/**
 * Apply the wanted entries to file text. Owned names that are no longer
 * wanted are removed; a wanted name taken by someone else's entry is left
 * alone and reported, unless it is in `replace`.
 */
export function patchMcpServers(source: string, wanted: McpEntry[], previouslyOwned: readonly string[], replace: ReadonlySet<string> = new Set()): PatchResult {
  let text = source;
  const tree = parseConfig(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol };
  for (const path of [["mcp"], ["mcp", "servers"]]) {
    const node = findNodeAtLocation(tree, path);
    if (node && node.type !== "object") throw new ConfigFileError(`opencode.json: "${path.join(".")}" must be an object`);
  }
  const owned = new Set(previouslyOwned);
  const wantedNames = new Set(wanted.map((entry) => entry.name));
  const edit = (path: string[], value: unknown) => {
    text = applyEdits(text, modify(text, path, value, { formattingOptions }));
  };
  const has = (path: string[]) => findNodeAtLocation(parseConfig(text), path) !== undefined;

  for (const name of previouslyOwned) {
    if (wantedNames.has(name)) continue;
    if (has(serverPath(name))) edit(serverPath(name), undefined);
    owned.delete(name);
  }

  const conflicts: string[] = [];
  for (const { name, value } of wanted) {
    const legacy = !MCP_RESERVED.has(name) && has(legacyPath(name));
    if (!owned.has(name) && (has(serverPath(name)) || legacy) && !replace.has(name)) {
      conflicts.push(name);
      continue;
    }
    if (legacy) edit(legacyPath(name), undefined);
    const current = findNodeAtLocation(parseConfig(text), serverPath(name));
    if (current === undefined || JSON.stringify(nodeValue(current)) !== JSON.stringify(value)) edit(serverPath(name), value);
    owned.add(name);
  }
  if (!text.endsWith(eol)) text += eol;
  return { text, owned: [...owned].sort(), conflicts };
}

export interface WriteResult extends PatchResult {
  changed: boolean;
}

const hash = (text: string | null) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

/** Patch `path` under the shared lock. */
export async function writeMcpServers(
  path: string,
  wanted: McpEntry[],
  previouslyOwned: readonly string[],
  replace: ReadonlySet<string>,
  options: LockOptions = {},
): Promise<WriteResult> {
  if (!isAbsolute(path)) throw new ConfigFileError("an absolute opencode.json path is required");
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const release = await acquireConfigLock(path, WRITER, options);
    try {
      const result = await writeOnce(path, wanted, previouslyOwned, replace, options.signal);
      if (result !== null) return result;
    } finally {
      await release();
    }
  }
  throw new ConfigFileError("opencode.json keeps changing; MCP Catalog will try again on the next check");
}

/** The current text, or null when there is no file yet. */
export async function readConfigText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const EMPTY = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

async function writeOnce(
  path: string,
  wanted: McpEntry[],
  previouslyOwned: readonly string[],
  replace: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<WriteResult | null> {
  const temporary = `${path}.${WRITER}-${randomUUID()}.tmp`;
  const backup = `${path}.before-${WRITER}.bak`;
  try {
    let original: string | null = null;
    let mode = 0o600;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ConfigFileError("opencode.json must be a regular file");
      mode = stat.mode & 0o777;
      original = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (original === null && wanted.length === 0) return { text: "", owned: [], conflicts: [], changed: false };
    const base = original === null || original.trim() === "" ? EMPTY : original;
    const result = patchMcpServers(base, wanted, previouslyOwned, replace);
    if (result.text === original) return { ...result, changed: false };
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(result.text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    if (original !== null) {
      try {
        const copy = await open(backup, "wx", 0o600);
        try {
          await copy.writeFile(original, "utf8");
          await copy.sync();
        } finally {
          await copy.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    signal?.throwIfAborted();
    if (hash(await readConfigText(path)) !== hash(original)) return null;
    await rename(temporary, path);
    return { ...result, changed: true };
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
