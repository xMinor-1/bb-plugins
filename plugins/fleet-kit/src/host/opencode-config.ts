// Fleet Kit's share of OpenCode 2's opencode.json.
//
// The manifest's `opencode` block is a native OpenCode 2 configuration
// fragment. Fleet Kit owns exactly:
//   - `providers.<id>` for every provider the block declares;
//   - `agents.<id>` for every agent the block declares, `experimental.<key>`
//     for every experimental key, and only `mcp.timeout` of `mcp` (servers
//     belong to the person and to other plugins);
//   - every other top-level key the block declares (`model`, `update`, ...);
//   - `enabled_providers`, set from the manifest's `allowedProviders`;
//   - one entry of `instructions`: the build's agent rules file, when the
//     manifest has `agentRules`. The person's own entries stay.
// Everything else in the file (the user's own settings, MCP servers written by
// other plugins, comments) is preserved byte for byte. Paths Fleet Kit owned
// before and the manifest no longer declares are removed.
//
// Secrets: `{secret:name}` is accepted only as the whole `settings.apiKey`
// (sent as `Authorization: Bearer <secret>`) or inside `settings.headers.<H>`.
// Those entries are left out of the file; the resolver plugin adds the headers
// from the operating system's credential store, and only to requests that go to
// the origin of the provider's `settings.baseURL` in the manifest.
//
// Writes follow the shared bb-config-lock protocol (see config-lock.ts): lock,
// read, patch, write a temporary file, back up the original once, re-read and
// compare hashes, rename. A file that changed underneath is re-read and
// patched again, up to five times.
// jsonc-parser's default entry is a UMD build whose internal requires esbuild
// cannot follow; the ESM build bundles cleanly.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { applyEdits, findNodeAtLocation, modify, parseTree, type Node, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { acquireConfigLock, type LockOptions } from "./config-lock.js";
import { baseUrlProblem, OPENCODE_KEYS, providerPackageProblem } from "../manifest.js";

export const WRITER = "fleet-kit";

// openCodeMajor is copied from plugins/qlik-sense/src/host/opencode-config.ts
// (commit c0399a0); check-models.ts imports it from here, as in qlik-sense.
export type OpenCodeMajor = 1 | 2;

export function openCodeMajor(versionOutput: string): OpenCodeMajor {
  const match = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(versionOutput.trim());
  if (!match) throw new Error("Unsupported OpenCode version; run opencode --version.");
  return Number(match[1]) as OpenCodeMajor;
}

export interface ResolverHeader {
  header: string;
  /** Header value with `{secret:name}` placeholders. */
  template: string;
}

export interface ResolverProvider {
  /** The only origin that receives the headers: the manifest's baseURL. */
  origin: string;
  headers: ResolverHeader[];
}

export interface OpenCodePlan {
  /** JSON paths Fleet Kit sets, with their values. */
  entries: { path: string[]; value: unknown }[];
  /** Headers the resolver plugin adds per provider. */
  resolver: Record<string, ResolverProvider>;
  /** Secret names the plan needs. */
  secrets: string[];
  /** Absolute path of the build's agent rules file to list in `instructions`. */
  instructions?: string;
}

/** The rules file's name inside the OpenCode configuration directory. */
export const RULES_FILE = "fleet-kit-rules.md";
const isRulesEntry = (value: unknown) => typeof value === "string" && /(^|[\\/])fleet-kit-rules\.md$/.test(value);

const SECRET_ONLY = /^\{secret:([a-z0-9][a-z0-9-]*)\}$/;
const hasSecretRef = (value: string) => /\{secret:[^}]*\}/.test(value);
const secretNamesIn = (value: string) => [...value.matchAll(/\{secret:([^}]*)\}/g)].map((match) => match[1] ?? "");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findSecretRefs(value: unknown, path: string[], found: string[][]): void {
  if (typeof value === "string") {
    if (hasSecretRef(value)) found.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretRefs(item, [...path, String(index)], found));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) findSecretRefs(item, [...path, key], found);
  }
}

/** Turn the manifest block into owned paths plus resolver headers. */
export function planOpenCode(
  block: Record<string, unknown>,
  allowedProviders: string[],
  options: { allowDevSources?: boolean; rulesFile?: string } = {},
): OpenCodePlan {
  const entries: OpenCodePlan["entries"] = [];
  const resolver: OpenCodePlan["resolver"] = {};
  const secrets = new Set<string>();
  const providers = (block.providers ?? {}) as Record<string, Record<string, unknown>>;

  for (const [providerId, original] of Object.entries(providers)) {
    const packageProblem = providerPackageProblem(original.package, options.allowDevSources === true);
    if (packageProblem !== null) throw new Error(`providers.${providerId}: ${packageProblem}`);
    const provider = clone(original);
    const settings = (provider.settings ?? undefined) as Record<string, unknown> | undefined;
    const headers: ResolverHeader[] = [];
    if (settings && typeof settings === "object") {
      if (typeof settings.apiKey === "string") {
        const match = SECRET_ONLY.exec(settings.apiKey);
        if (match) {
          headers.push({ header: "Authorization", template: `Bearer {secret:${match[1]}}` });
          secrets.add(match[1]!);
          delete settings.apiKey;
        }
      }
      const extra = settings.headers;
      if (extra && typeof extra === "object" && !Array.isArray(extra)) {
        for (const [name, value] of Object.entries(extra as Record<string, unknown>)) {
          if (typeof value !== "string" || !hasSecretRef(value)) continue;
          for (const secret of secretNamesIn(value)) {
            if (!/^[a-z0-9][a-z0-9-]*$/.test(secret)) throw new Error(`providers.${providerId}.settings.headers.${name}: invalid secret name`);
            secrets.add(secret);
          }
          headers.push({ header: name, template: value });
          delete (extra as Record<string, unknown>)[name];
        }
        if (Object.keys(extra).length === 0) delete settings.headers;
      }
      if (Object.keys(settings).length === 0) delete provider.settings;
    }
    const leftovers: string[][] = [];
    findSecretRefs(provider, ["providers", providerId], leftovers);
    if (leftovers.length > 0) {
      throw new Error(`${leftovers[0]!.join(".")}: {secret:...} is supported only in settings.apiKey and settings.headers`);
    }
    if (headers.length > 0) {
      const baseURL = settings?.baseURL;
      const problem = baseUrlProblem(baseURL, options.allowDevSources === true);
      if (problem !== null) throw new Error(`providers.${providerId}: ${problem}`);
      resolver[providerId] = { origin: new URL(baseURL as string).origin, headers };
    }
    entries.push({ path: ["providers", providerId], value: provider });
  }

  for (const [key, value] of Object.entries(block)) {
    if (key === "providers") continue;
    if (key === "enabled_providers") throw new Error("opencode.enabled_providers: use allowedProviders at the manifest root");
    if (!(OPENCODE_KEYS as readonly string[]).includes(key)) throw new Error(`opencode.${key}: a build may set only ${OPENCODE_KEYS.join(", ")}`);
    const leftovers: string[][] = [];
    findSecretRefs(value, [key], leftovers);
    if (leftovers.length > 0) throw new Error(`opencode.${leftovers[0]!.join(".")}: {secret:...} is supported only in provider settings`);
    if (key === "agents" || key === "experimental") {
      for (const [name, item] of Object.entries(value as Record<string, unknown>)) entries.push({ path: [key, name], value: clone(item) });
    } else if (key === "mcp") {
      const mcp = value as Record<string, unknown>;
      if (Object.keys(mcp).some((name) => name !== "timeout")) throw new Error("opencode.mcp: a build may set only mcp.timeout");
      if (mcp.timeout !== undefined) entries.push({ path: ["mcp", "timeout"], value: clone(mcp.timeout) });
    } else {
      entries.push({ path: [key], value: clone(value) });
    }
  }
  entries.push({ path: ["enabled_providers"], value: [...allowedProviders] });
  const plan: OpenCodePlan = { entries, resolver, secrets: [...secrets].sort() };
  if (options.rulesFile !== undefined) {
    if (!isAbsolute(options.rulesFile) || !isRulesEntry(options.rulesFile)) throw new Error(`the agent rules file must be an absolute path to ${RULES_FILE}`);
    plan.instructions = options.rulesFile;
  }
  return plan;
}

const pathKey = (path: string[]) => JSON.stringify(path);

function parseConfig(source: string): Node {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || tree?.type !== "object") throw new Error("opencode.json must be a valid JSON or JSONC object");
  const walk = (node: Node): void => {
    if (node.type === "object") {
      const keys = (node.children ?? []).map((property) => property.children?.[0]?.value);
      if (new Set(keys).size !== keys.length) throw new Error("opencode.json contains duplicate keys");
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return tree;
}

/** Apply the plan to file text. `previouslyOwned` paths absent from the plan are removed. */
export function patchOpenCodeConfig(source: string, plan: OpenCodePlan, previouslyOwned: string[][]): string {
  let text = source;
  const tree = parseConfig(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol };
  for (const { path } of plan.entries) {
    for (let index = 1; index < path.length; index++) {
      const parent = findNodeAtLocation(tree, path.slice(0, index));
      if (parent && parent.type !== "object") throw new Error(`opencode.json: "${path.slice(0, index).join(".")}" must be an object`);
    }
  }
  const wanted = new Set(plan.entries.map((entry) => pathKey(entry.path)));
  for (const path of previouslyOwned) {
    if (wanted.has(pathKey(path))) continue;
    if (findNodeAtLocation(parseConfig(text), path) === undefined) continue;
    text = applyEdits(text, modify(text, path, undefined, { formattingOptions }));
    // A nested path (agents.<id>, experimental.<key>, mcp.timeout) may leave its parent empty: drop that too.
    const parentPath = path.slice(0, -1);
    const parent = parentPath.length > 0 ? findNodeAtLocation(parseConfig(text), parentPath) : undefined;
    if (parent?.type === "object" && (parent.children ?? []).length === 0) {
      text = applyEdits(text, modify(text, parentPath, undefined, { formattingOptions }));
    }
  }
  for (const { path, value } of plan.entries) {
    const current = findNodeAtLocation(parseConfig(text), path);
    if (current !== undefined && JSON.stringify(nodeValue(current)) === JSON.stringify(value)) continue;
    text = applyEdits(text, modify(text, path, value, { formattingOptions }));
  }
  text = patchInstructions(text, plan.instructions, formattingOptions);
  if (!text.endsWith(eol)) text += eol;
  return text;
}

/**
 * Keep exactly one rules entry in `instructions` (or none without rules),
 * after the person's own entries. A string `instructions` is the person's
 * and is left alone.
 */
function patchInstructions(text: string, rulesFile: string | undefined, formattingOptions: { insertSpaces: boolean; tabSize: number; eol: string }): string {
  const node = findNodeAtLocation(parseConfig(text), ["instructions"]);
  if (node !== undefined && node.type !== "array") {
    if (rulesFile === undefined) return text;
    throw new Error('opencode.json: "instructions" must be a list');
  }
  const current = node === undefined ? [] : (nodeValue(node) as unknown[]);
  const own = current.filter((entry) => !isRulesEntry(entry));
  const wanted = rulesFile === undefined ? own : [...own, rulesFile];
  if (JSON.stringify(wanted) === JSON.stringify(current)) return text;
  const value = wanted.length === 0 ? undefined : wanted;
  return applyEdits(text, modify(text, ["instructions"], value, { formattingOptions }));
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

/** Current values at the owned paths, for status display (no secrets live there). */
export function readOwnedValue(source: string, path: string[]): unknown {
  const node = findNodeAtLocation(parseConfig(source), path);
  return node === undefined ? undefined : nodeValue(node);
}

export interface WriteResult {
  changed: boolean;
  backup: string | null;
}

const hash = (text: string | null) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

/** Patch `path` under the shared lock. */
export async function writeOpenCodeConfig(
  path: string,
  plan: OpenCodePlan,
  previouslyOwned: string[][],
  options: LockOptions = {},
): Promise<WriteResult> {
  if (!isAbsolute(path)) throw new Error("an absolute opencode.json path is required");
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const release = await acquireConfigLock(path, WRITER, options);
    try {
      const result = await writeOnce(path, plan, previouslyOwned, options.signal);
      if (result !== null) return result;
    } finally {
      await release();
    }
  }
  throw new Error("opencode.json keeps changing; Fleet Kit will try again on the next sync");
}

async function writeOnce(path: string, plan: OpenCodePlan, previouslyOwned: string[][], signal?: AbortSignal): Promise<WriteResult | null> {
  const temporary = `${path}.${WRITER}-${randomUUID()}.tmp`;
  const backup = `${path}.before-${WRITER}.bak`;
  try {
    let original: string | null = null;
    let mode = 0o600;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("opencode.json must be a regular file");
      mode = stat.mode & 0o777;
      original = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const base = original === null || original.trim() === "" ? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' : original;
    const text = patchOpenCodeConfig(base, plan, previouslyOwned);
    if (text === original) return { changed: false, backup: null };
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    let backupPath: string | null = null;
    if (original !== null) {
      try {
        const copy = await open(backup, "wx", 0o600);
        try {
          await copy.writeFile(original, "utf8");
          await copy.sync();
        } finally {
          await copy.close();
        }
        backupPath = backup;
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
    return { changed: true, backup: backupPath };
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
