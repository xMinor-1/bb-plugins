// src/mentions.ts — "@ a file that lives on this machine" (§8.8).
//
// bb's own attachment picker uploads from the machine the *browser* runs on.
// This provider is the other half: the composer can also reach a file on the
// machine the bb *server* runs on, which is the only tree this plugin ever
// touches, under exactly the same §6 clamp as every other read.
//
// Two host contracts shape everything below, and neither is negotiable:
//
//   * `search` is time-boxed at 2s and failure-isolated — a slow or throwing
//     provider silently contributes an empty list. So the walk carries its own
//     budget (an abandoned walk still costs the disk) and nothing throws.
//   * `resolve` runs once per picked item AT SEND TIME, and a throw BLOCKS the
//     send with an error the user has to clear. A file that vanished between
//     picking and sending is not worth blocking a message over, so every
//     failure comes back as prose inside `context` instead.
import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type {
  BbPluginApi,
  PluginMentionItem,
  PluginMentionProviderRegistration,
  PluginMentionSearchContext,
} from "@get-bb/plugin-sdk";

import { MENTION_PROVIDER_ID, MENTION_PROVIDER_LABEL } from "../contract";
import { searchDir } from "./listing";
import { getRoot, resolveExisting } from "./root";

/** Rows offered in the mention menu. More than this is a scroll, not a pick. */
const SEARCH_LIMIT = 20;
/**
 * Matches are read breadth-first, so this is "how far down the home folder a
 * name is still worth offering". Four levels covers `~/work/<project>/<dir>/`;
 * deeper than that the walk costs more than the row is worth.
 */
const SEARCH_DEPTH = 4;
/** Under bb's 2s box, so the walk stops itself before the host drops it. */
const SEARCH_BUDGET_MS = 1_500;
/**
 * A candidate pool wider than the menu, because directories and links that
 * escape the root are dropped afterwards: capping the walk at 20 could
 * otherwise answer a query that matches 20 folders with no files at all.
 */
const SEARCH_CANDIDATES = SEARCH_LIMIT * 4;

/** Text beyond this is truncated, with a line saying so. 256 KB ≈ 60k tokens. */
export const MAX_CONTEXT_BYTES = 256 * 1024;
/** How much of the head decides "is this text?" — a NUL this deep is enough. */
const SNIFF_BYTES = 8 * 1024;
/**
 * Replacement characters per decoded character above which the prefix is
 * called binary. Real UTF-8 text has none; one truncated code point at the cut
 * is expected, so the test is a ratio and not a presence check.
 */
const REPLACEMENT_RATIO = 0.01;

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

/** `~`-style label for the menu's second line: where the file is, not what. */
function relativeLabel(absolutePath: string): string {
  const root = getRoot();
  if (absolutePath === root) return "~";
  if (!absolutePath.startsWith(root + path.sep)) return absolutePath;
  return `~${absolutePath.slice(root.length)}`;
}

export async function searchFiles(ctx: PluginMentionSearchContext): Promise<PluginMentionItem[]> {
  const query = ctx.query.trim();
  // The host asks with an empty query the moment the trigger is typed. Walking
  // the home folder to answer "everything" would be the most expensive call
  // this provider can make, for the least useful list.
  if (query.length === 0) return [];

  try {
    const result = await searchDir({
      path: getRoot(),
      query,
      // A dot-file is reachable by typing its name in the panel's own search,
      // but offering `.ssh/id_ed25519` as a menu row on the way to something
      // else is not a list anybody asked for.
      showHidden: false,
      maxDepth: SEARCH_DEPTH,
      limit: SEARCH_CANDIDATES,
      budgetMs: SEARCH_BUDGET_MS,
    });

    return result.entries
      .filter((entry) => {
        // Directories have no content to attach, and a link out of the root is
        // a row that could only fail: `resolve` refuses it (§6).
        if (entry.escapesRoot) return false;
        const kind = entry.isSymlink && entry.targetKind !== null ? entry.targetKind : entry.kind;
        return kind === "file";
      })
      .slice(0, SEARCH_LIMIT)
      .map((entry) => ({
        id: entry.path,
        title: entry.name,
        subtitle: relativeLabel(entry.path),
      }));
  } catch {
    // Any failure is the same answer the host would synthesize from a throw —
    // no rows — except this way it does not count against the plugin.
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* resolve                                                             */
/* ------------------------------------------------------------------ */

function headerFor(absolutePath: string, stats: Stats): string {
  return [
    `File: ${absolutePath}`,
    `Size: ${String(stats.size)} bytes`,
    `Modified: ${new Date(stats.mtimeMs).toISOString()}`,
  ].join("\n");
}

/**
 * A fence longer than any backtick run inside the content, so a file that
 * contains its own code fences cannot end the block early.
 */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Extension as a fence info string, when it is one plain word. */
function languageFor(absolutePath: string): string {
  const extension = path.extname(absolutePath).slice(1).toLowerCase();
  return /^[a-z0-9]+$/u.test(extension) ? extension : "";
}

/** NUL bytes, or a decode too lossy to be text. */
function looksBinary(buffer: Buffer, decoded: string): boolean {
  if (buffer.subarray(0, SNIFF_BYTES).includes(0)) return true;
  if (decoded.length === 0) return false;
  let replacements = 0;
  for (const character of decoded) if (character === "�") replacements += 1;
  return replacements / decoded.length > REPLACEMENT_RATIO;
}

/** Read at most `MAX_CONTEXT_BYTES` from the head of a file. */
async function readHead(absolutePath: string): Promise<Buffer> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_CONTEXT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_CONTEXT_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function resolveFile(itemId: string): Promise<{ context: string }> {
  try {
    // The item id is whatever came back from `search`, but it round-trips
    // through the draft and the wire, so it is treated as user input: the same
    // realpath-then-prefix check every other read goes through (§6).
    const real = await resolveExisting(itemId);
    const stats = await stat(real);
    const header = headerFor(real, stats);

    if (stats.isDirectory()) {
      return {
        context: `${header}\n\nThis is a directory. Its contents are not attached — read it with your own tools if you need them.`,
      };
    }
    if (!stats.isFile()) {
      return { context: `${header}\n\nThis is not a regular file, so no content is attached.` };
    }
    if (stats.size === 0) return { context: `${header}\n\nThe file is empty.` };

    const head = await readHead(real);
    const decoded = new TextDecoder("utf-8").decode(head);
    if (looksBinary(head, decoded)) {
      return {
        context: `${header}\n\nThe file is binary, so its content is not attached.`,
      };
    }

    const truncated = head.length < stats.size;
    const fence = fenceFor(decoded);
    const body = `${fence}${languageFor(real)}\n${decoded}\n${fence}`;
    const note = truncated
      ? `\n\n[Truncated: the first ${String(head.length)} of ${String(stats.size)} bytes are shown.]`
      : "";
    return { context: `${header}\n\n${body}${note}` };
  } catch (error) {
    // Deliberately not a throw: blocking the send would punish the user for a
    // file that moved, and the agent can act on being told which one it was.
    const detail = error instanceof Error ? error.message : String(error);
    return { context: `File: ${itemId}\n\nThis file could not be read (${detail}).` };
  }
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

/** The registration itself, exported so tests can drive it without a host. */
export function createFileMentionProvider(): PluginMentionProviderRegistration {
  return {
    id: MENTION_PROVIDER_ID,
    label: MENTION_PROVIDER_LABEL,
    // `triggers` is omitted on purpose: "@" is the trigger every bb user
    // already knows, and claiming "#" or "~" as well would put this plugin's
    // rows in menus it has no business being in.
    search: searchFiles,
    resolve: resolveFile,
  };
}

export function registerMentions(bb: BbPluginApi): void {
  bb.ui.registerMentionProvider(createFileMentionProvider());
}
