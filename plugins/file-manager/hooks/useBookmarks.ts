// hooks/useBookmarks.ts — the panel's copy of the bookmark list (§8.11).
//
// Deliberately thin. Every mutator answers with the whole list, so there is no
// local reconciliation to get wrong: the hook just paints whatever the backend
// last said. The one piece of machinery is the stamp below.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MAX_BOOKMARKS, type Bookmark } from "../contract";
import { isBookmarked as isBookmarkedIn } from "../lib/bookmarks";
import { useFmRpc } from "../lib/fm-rpc";

export interface UseBookmarksResult {
  bookmarks: readonly Bookmark[];
  /** True until the first list lands — the star has no state to show yet. */
  loading: boolean;
  /** True when one more would be refused; the panel says so itself. */
  full: boolean;
  isBookmarked: (path: string) => boolean;
  /** `name` null (the default) lets the backend use the folder's own name. */
  add: (path: string, name?: string | null) => Promise<void>;
  remove: (path: string) => Promise<void>;
  rename: (path: string, name: string) => Promise<void>;
  /** Re-read the list. `available` is a fact about *now*, so it goes stale. */
  refresh: () => void;
}

export function useBookmarks(): UseBookmarksResult {
  const rpc = useFmRpc();
  const [bookmarks, setBookmarks] = useState<readonly Bookmark[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * Every call is stamped when it is *issued*, and only a newer stamp may
   * paint. Without it the background re-read fired when the menu opened can
   * land after the removal the user clicked inside that same menu, and put the
   * row they just deleted back on screen.
   */
  const issuedRef = useRef(0);
  const paintedRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const run = useCallback(
    async (call: () => Promise<{ bookmarks: Bookmark[] }>): Promise<void> => {
      const stamp = (issuedRef.current += 1);
      const result = await call();
      if (!mountedRef.current || stamp <= paintedRef.current) return;
      paintedRef.current = stamp;
      setBookmarks(result.bookmarks);
    },
    [],
  );

  const refresh = useCallback(() => {
    void run(() => rpc.call("listBookmarks", null))
      .catch(() => {
        // A list the user did not ask for must not raise anything: the panel
        // still lists the folder fine, and the star simply stays as it was.
        // Failures of an *action* are toasted by the caller instead.
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, [rpc, run]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    (path: string, name: string | null = null): Promise<void> =>
      run(() => rpc.call("addBookmark", { path, name })),
    [rpc, run],
  );

  const remove = useCallback(
    (path: string): Promise<void> => run(() => rpc.call("removeBookmark", { path })),
    [rpc, run],
  );

  const rename = useCallback(
    (path: string, name: string): Promise<void> =>
      run(() => rpc.call("renameBookmark", { path, name })),
    [rpc, run],
  );

  const isBookmarked = useCallback(
    (path: string) => isBookmarkedIn(bookmarks, path),
    [bookmarks],
  );

  return useMemo(
    () => ({
      bookmarks,
      loading,
      full: bookmarks.length >= MAX_BOOKMARKS,
      isBookmarked,
      add,
      remove,
      rename,
      refresh,
    }),
    [add, bookmarks, isBookmarked, loading, refresh, remove, rename],
  );
}
