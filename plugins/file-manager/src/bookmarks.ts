// src/bookmarks.ts — §8.11. The folder shortcuts the toolbar's star writes.
//
// Why `bb.storage.kv` and not a setting (§7.1 said kv was unused in v0.1, and
// this is the case that changed its mind): a settings descriptor is a flat
// scalar of one of four declared types, none of which is "list of records".
// Encoding a JSON array into the `string` descriptor would put a blob on the
// plugin's settings page for a human to edit by hand, and would make every
// add a read-modify-write through `sdk.plugins.updateSettings`. kv takes a
// JSON value directly, so the list stays one atomic row and stays off the
// settings form. It is server-side on purpose, unlike the last-folder memory
// (lib/last-folder.ts): a bookmark is a decision the user made about this
// machine's folders, and it should survive a different browser profile.
//
// Every path in or out of this module goes through src/root.ts, in one of two
// strengths:
//
//   * writing clamps with `resolveExistingDir` — realpath BEFORE the prefix
//     test — so the *stored* form can never point outside the root later, in
//     exactly the way `validateStartFolder` stores a realpath'ed folder;
//   * reading, removing and renaming clamp lexically (`normalize` +
//     `assertInside` / `isInside`), because a bookmark whose folder is gone
//     has no realpath to check and must still be listable and removable. The
//     lexical form never reaches node:fs — it is only compared against the
//     strings already stored — and `normalize` resolves "..", so it cannot
//     climb out of the root either.
//
// There is deliberately no `reorderBookmarks`. The list is insertion-ordered,
// which is the order the user built it in, and the only surface that shows it
// is a menu — a menu is not a drag surface, and no other affordance in this
// plugin could reach the method. An RPC on a frozen contract that no caller
// can invoke is weight with no user behind it, so reordering waits for the
// manage-bookmarks screen that would actually need it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import path from "node:path";

import {
  MAX_BOOKMARKS,
  MAX_BOOKMARK_NAME_LENGTH,
  type Bookmark,
} from "../contract";
import { fmError } from "./errors";
import { assertInside, isInside, normalize, resolveExistingDir } from "./root";

/**
 * The kv key. Versioned in the key rather than inside the value, so a shape
 * change is a new key and never a migration — the same rule the client store
 * follows (lib/fm-store.ts).
 */
export const BOOKMARKS_KEY = "bookmarks:v1";

/** What the kv row actually holds. Order is the array order, nothing more. */
interface StoredBookmark {
  path: string;
  name: string;
}

export interface AddBookmarkInput {
  path: string;
  name: string | null;
}

export interface BookmarksResult {
  bookmarks: Bookmark[];
}

export interface BookmarksModule {
  list(): Promise<BookmarksResult>;
  add(input: AddBookmarkInput): Promise<BookmarksResult>;
  remove(input: { path: string }): Promise<BookmarksResult>;
  rename(input: { path: string; name: string }): Promise<BookmarksResult>;
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line no-control-regex -- deliberate: reject control chars
const CONTROL_CHARACTERS = /[\x00-\x1f]/u;

/** The name a folder gets when the caller supplied none. */
function defaultName(absolute: string): string {
  const base = path.basename(absolute);
  // Only the filesystem root has an empty base name, and it is a legal
  // bookmark, so it keeps its path as its label instead of an empty row.
  return base === "" ? absolute : base;
}

/**
 * Strict validation, for a name a caller *chose*. Counted in code points, not
 * bytes: this string never becomes a file name, so the 255-byte rule of
 * `validateName` (§6) does not apply and would only punish non-Latin labels.
 */
function validateBookmarkName(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") throw fmError("invalid_name", "(empty)");
  if (CONTROL_CHARACTERS.test(trimmed)) throw fmError("invalid_name", trimmed);
  if ([...trimmed].length > MAX_BOOKMARK_NAME_LENGTH) {
    throw fmError("invalid_name", `${trimmed.slice(0, 32)}…`);
  }
  return trimmed;
}

/**
 * Forgiving repair, for a name that came back out of storage. A corrupt row
 * degrades to something renderable instead of throwing: a throw here would
 * take the whole bookmark list down over one bad entry.
 */
function repairName(input: unknown, absolute: string): string {
  if (typeof input !== "string") return defaultName(absolute);
  const cleaned = input.replace(CONTROL_CHARACTERS, " ").trim();
  if (cleaned === "") return defaultName(absolute);
  const points = [...cleaned];
  return points.length > MAX_BOOKMARK_NAME_LENGTH
    ? points.slice(0, MAX_BOOKMARK_NAME_LENGTH).join("")
    : cleaned;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Decode the kv row: drop anything unusable, dedupe by path, cap the length.
 *
 * A row recorded under a *different* root — the same bb data directory carried
 * to a host whose home is somewhere else — is dropped rather than marked
 * unavailable. "Unavailable" tells the user to wait for the folder to come
 * back; a path outside the root can never be opened from here at all.
 */
function decode(raw: unknown): StoredBookmark[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: StoredBookmark[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const stored = candidate.path;
    if (typeof stored !== "string" || stored === "") continue;
    const absolute = normalize(stored);
    if (!isInside(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    items.push({ path: absolute, name: repairName(candidate.name, absolute) });
    if (items.length >= MAX_BOOKMARKS) break;
  }
  return items;
}

/**
 * True when the folder can be opened right now.
 *
 * `resolveExistingDir`, not a bare `stat`: a bookmarked folder that has since
 * become a symlink pointing out of the root must not answer "available" and
 * sit one click away in a menu.
 */
async function isOpenable(absolute: string): Promise<boolean> {
  try {
    await resolveExistingDir(absolute);
    return true;
  } catch {
    return false;
  }
}

/** Stored rows → wire rows: adds the position and the freshness probe. */
async function decorate(items: readonly StoredBookmark[]): Promise<Bookmark[]> {
  return Promise.all(
    items.map(async (item, index) => ({
      path: item.path,
      name: item.name,
      order: index,
      available: await isOpenable(item.path),
    })),
  );
}

/**
 * The lexical half of the root check, for the operations that must work on a
 * folder that no longer exists. Throws `path_escape` exactly like the strict
 * form does.
 */
function clampLexically(input: string): string {
  return assertInside(normalize(input));
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export function createBookmarks(bb: BbPluginApi): BookmarksModule {
  async function read(): Promise<StoredBookmark[]> {
    try {
      return decode(await bb.storage.kv.get<unknown>(BOOKMARKS_KEY));
    } catch (error) {
      // A storage that cannot be read is not a reason to fail the panel's
      // bootstrap: the list degrades to empty and says so in the log. A
      // *write* still throws, because the user asked for that one.
      bb.log.warn(`bookmarks are unreadable (${String(error)}); using an empty list`);
      return [];
    }
  }

  async function write(items: readonly StoredBookmark[]): Promise<BookmarksResult> {
    await bb.storage.kv.set(BOOKMARKS_KEY, items);
    return { bookmarks: await decorate(items) };
  }

  return {
    async list(): Promise<BookmarksResult> {
      return { bookmarks: await decorate(await read()) };
    },

    async add(input: AddBookmarkInput): Promise<BookmarksResult> {
      // realpath BEFORE the prefix test, and "must be a directory" with it:
      // only a folder that exists today is worth storing an absolute path for.
      const absolute = await resolveExistingDir(input.path);
      const items = await read();
      const existing = items.findIndex((item) => item.path === absolute);

      if (existing !== -1) {
        // Idempotent. The toolbar star is a toggle, so a repeat add is a
        // double click, not a request to move the row to the end of the list.
        // An explicit name is the one thing that could only have been meant.
        if (input.name === null) return { bookmarks: await decorate(items) };
        const renamed = [...items];
        renamed[existing] = { path: absolute, name: validateBookmarkName(input.name) };
        return await write(renamed);
      }

      if (items.length >= MAX_BOOKMARKS) {
        // No dedicated code exists in the frozen enum and inventing one would
        // widen the contract for one message; `unsupported` is the honest
        // "this cannot be done in this state", and the panel refuses before
        // it ever gets here (lib/bookmarks.ts#BOOKMARKS_FULL_TEXT).
        throw fmError("unsupported", `the bookmark list is full (${String(MAX_BOOKMARKS)} maximum)`);
      }

      const name =
        input.name === null ? defaultName(absolute) : validateBookmarkName(input.name);
      return await write([...items, { path: absolute, name }]);
    },

    async remove(input: { path: string }): Promise<BookmarksResult> {
      const absolute = clampLexically(input.path);
      const items = await read();
      const next = items.filter((item) => item.path !== absolute);
      // Removing something that is already gone is not an error: two clicks on
      // one stale row must not end in a toast. The list that comes back is the
      // truth either way, so an unchanged list is simply not written.
      if (next.length === items.length) return { bookmarks: await decorate(items) };
      return await write(next);
    },

    async rename(input: { path: string; name: string }): Promise<BookmarksResult> {
      const absolute = clampLexically(input.path);
      const name = validateBookmarkName(input.name);
      const items = await read();
      const index = items.findIndex((item) => item.path === absolute);
      // Renaming *is* addressed at one row, so a missing one is a real
      // failure — unlike remove, there is nothing sensible to answer with.
      if (index === -1) throw fmError("not_found", absolute);
      const next = items.map((item, at) => (at === index ? { path: item.path, name } : item));
      return await write(next);
    },
  };
}
