// lib/bookmarks.ts — the panel side of §8.11: wording, and the one piece of
// arithmetic the bookmark UI does.
//
// Same split as lib/start-folder.ts: three surfaces reach the bookmark list
// (the toolbar star, the bookmarks menu, the two context menus), so the toast
// text and the "am I bookmarked?" test live here rather than being written
// three times in three components. `isBookmarked` is pure so the decision can
// be tested without a renderer.
import { MAX_BOOKMARKS, type Bookmark } from "../contract";
import { isSamePath } from "./fm-paths";

export const BOOKMARK_ADD_FAILED_TEXT = "Could not add that bookmark.";
export const BOOKMARK_REMOVE_FAILED_TEXT = "Could not remove that bookmark.";
export const BOOKMARK_RENAME_FAILED_TEXT = "Could not rename that bookmark.";

/**
 * Said *before* the RPC, never after it.
 *
 * The backend refuses the 51st bookmark with `unsupported`, whose stock
 * sentence ("That operation is not supported.") tells the user nothing about
 * what to do. The panel knows the count, so it can say the useful thing and
 * skip the round trip.
 */
export const BOOKMARKS_FULL_TEXT =
  `You can keep ${String(MAX_BOOKMARKS)} bookmarks. Remove one before adding another.`;

/**
 * True when `path` is in the list.
 *
 * Compared with `isSamePath`, not with `===`: a path arriving from a route or
 * from a crumb can carry a trailing slash that the stored, realpath'ed form
 * never has, and a star that failed to light up over a slash would be a bug
 * with no visible cause.
 */
export function isBookmarked(bookmarks: readonly Bookmark[], path: string): boolean {
  if (path === "") return false;
  return bookmarks.some((bookmark) => isSamePath(bookmark.path, path));
}

/** The bookmark for `path`, or null. Used to seed the rename dialog. */
export function findBookmark(
  bookmarks: readonly Bookmark[],
  path: string,
): Bookmark | null {
  if (path === "") return null;
  return bookmarks.find((bookmark) => isSamePath(bookmark.path, path)) ?? null;
}
