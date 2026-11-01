// The directory of chats and people, kept on this machine (owner-only file) so that a search does
// not have to start the browser. Names, positions and the other spellings of names come from the
// client itself (it keeps transliterations and keyboard-layout variants for search).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Chat, ChatKind } from "../../contract.js";
import { findBest, type Match } from "../shared/match.js";

/** One chat as the DIRECTORY page expression returns it (src/host/page.ts). */
export interface RawChat {
  id: string;
  type: string | null;
  name: string | null;
  aliases: string[];
  left: boolean;
  unread: number;
  members: number;
  visible: boolean;
  lastAt: number | null;
  stealth: boolean;
  person: { name: string | null; position: string | null; department: string | null; email: string | null; bot: boolean; aliases: string[] } | null;
}

export interface Directory {
  readonly url: string;
  readonly at: number;
  readonly chats: RawChat[];
}

/** Calls, threads under messages and the server-wide chat are not something a person writes to. */
const SKIP_TYPES = new Set(["voex_call", "thread", "global"]);

export function kindOf(type: string | null): ChatKind {
  const t = String(type ?? "").toLowerCase();
  if (t === "chat" || t === "personal" || t === "direct") return "personal";
  if (t.includes("group")) return "group";
  if (t.includes("channel")) return "channel";
  if (t.includes("bot")) return "bot";
  if (t.includes("note")) return "notes";
  return "other";
}

export function toChat(raw: RawChat): Chat {
  const p = raw.person;
  return {
    id: raw.id,
    kind: kindOf(raw.type),
    name: raw.name ?? "(no name)",
    unread: raw.unread,
    members: raw.members,
    lastAt: raw.lastAt,
    person: p ? { name: p.name, position: p.position, department: p.department, email: p.email } : null,
  };
}

interface Searchable {
  readonly raw: RawChat;
  readonly name: string | null;
  readonly aliases: readonly string[];
}

export function searchable(directory: Directory): Searchable[] {
  return directory.chats
    .filter((raw) => raw.name && !raw.left && !SKIP_TYPES.has(String(raw.type)))
    .map((raw) => ({ raw, name: raw.name, aliases: [...raw.aliases, ...(raw.person ? [raw.person.name, ...raw.person.aliases] : [])].filter((x): x is string => !!x) }));
}

export function search(directory: Directory, query: string, options: { limit?: number; strict?: boolean } = {}): { matches: Match<Searchable>[]; ambiguous: boolean } {
  return findBest(query, searchable(directory), { limit: options.limit ?? 3, strict: options.strict });
}

/**
 * A fresh read of the client merged with the saved directory: after a restart the client knows
 * people only once it has shown them, so a personal chat keeps its person from the last full sync.
 */
export function merge(fresh: RawChat[], saved: Directory | null): RawChat[] {
  if (!saved) return fresh;
  const before = new Map(saved.chats.map((raw) => [raw.id, raw]));
  return fresh.map((raw) => {
    const old = before.get(raw.id);
    if (!old) return raw;
    const person = raw.person?.name ? raw.person : (old.person ?? raw.person);
    return { ...raw, name: raw.name ?? old.name, aliases: raw.aliases.length ? raw.aliases : old.aliases, person };
  });
}

export function loadDirectory(file: string, url: string): Directory | null {
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Directory;
    return data.url === url && Array.isArray(data.chats) ? data : null;
  } catch {
    return null;
  }
}

export function saveDirectory(file: string, directory: Directory): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(directory), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export function counts(directory: Directory): { chats: number; people: number } {
  return { chats: searchable(directory).length, people: directory.chats.filter((raw) => raw.person?.name).length };
}
