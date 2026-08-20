// hooks/useTree.ts — the expanded set, the lazy child listings and the flatten.
//
// Mounted once, in `FileManagerPanel`, directly after `useDirectory`. It owns:
//   * the `TreeState` reducer (pure, in `lib/fm-tree.ts`);
//   * the `listDir` fan-out, capped at LOAD_CONCURRENCY and driven by the
//     *visible* rows, which makes a cold restore breadth-first for free;
//   * its own `fs` subscription — the runtime keeps a Set of handlers per
//     channel, so a second listener next to `useDirectory`'s is legal — plus
//     the reconnect sweep (§7.3: signals published while the socket was down
//     are gone);
//   * the two-tier persistence of the expanded set (module scope + localStorage).
//
// It returns rows, not raw state, so the loader effect can key off what is
// actually on screen.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

import { FS_CHANNEL, type FileEntry } from "../contract";
import { parseRpcError } from "../lib/errors";
import { isInsideRoot, normalizePath } from "../lib/fm-paths";
import { useFmRpc } from "../lib/fm-rpc";
import {
  EMPTY_TREE_STATE,
  EXPANDED_STORAGE_KEY,
  EXPANDED_STORAGE_MAX_BYTES,
  LOAD_CONCURRENCY,
  MAX_EXPANDED_PATHS,
  flattenTree,
  treeReducer,
  type TreeAction,
  type TreeNode,
  type TreeRow,
} from "../lib/fm-tree";
import type { SortDirection, SortField } from "./useDirectory";

/* ------------------------------------------------------------------ */
/* Persistence (§6)                                                    */
/* ------------------------------------------------------------------ */

/** Tier 1: survives a remount of the panel inside one page session. */
let sessionExpanded: string[] | null = null;

function readExpanded(): string[] {
  if (sessionExpanded !== null) return sessionExpanded;
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    const paths = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
    sessionExpanded = paths.filter((path) => isInsideRoot(path)).slice(-MAX_EXPANDED_PATHS);
  } catch {
    // Storage denied (an Electron partition can do this) or a corrupt row:
    // degrade to tier 1. Throwing here would kill the plugin's whole UI.
    sessionExpanded = [];
  }
  return sessionExpanded;
}

/** Tier 1 alone: cheap, synchronous, and what a remount reads back. */
function rememberExpanded(paths: readonly string[]): void {
  sessionExpanded = [...paths];
}

function writeExpanded(paths: readonly string[]): void {
  sessionExpanded = [...paths];
  try {
    const json = JSON.stringify(sessionExpanded);
    if (json.length > EXPANDED_STORAGE_MAX_BYTES) return; // never blow the quota
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, json);
  } catch {
    /* tier 1 only */
  }
}

/** Test seam, mirroring `resetPanelSnapshot` / `resetUploadManager`. */
export function resetTreeStore(): void {
  sessionExpanded = null;
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export interface UseTreeArgs {
  /** Current directory = the flatten root. */
  rootPath: string;
  /** Level-0 rows, already sorted by `useDirectory` (query NOT applied). */
  rootEntries: readonly FileEntry[];
  showHidden: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  /** The toolbar filter; "" disables filtering. */
  query: string;
  /** False while `getState` is still loading. */
  enabled: boolean;
}

export interface UseTreeResult {
  rows: readonly TreeRow[];
  /** Paths of the `kind: "entry"` rows, in render order. Feeds `useSelection`. */
  visiblePaths: string[];
  /** True when the flatten hit `MAX_TREE_ROWS`. */
  rowsTruncated: boolean;
  expandedCount: number;
  isExpanded: (path: string) => boolean;
  toggle: (entry: FileEntry) => void;
  expand: (path: string) => void;
  collapse: (path: string) => void;
  collapseAll: () => void;
  /** Cached listing of one directory, or null when it was never fetched. */
  nodeEntries: (path: string) => readonly FileEntry[] | null;
  /** Retry one failed node. */
  reload: (path: string) => void;
  /** Manual refresh: mark every cached node stale. */
  refreshAll: () => void;
  /** Delete/move: drop these paths and everything below them. */
  pruneSubtree: (paths: readonly string[]) => void;
  /** Rename: re-key the subtree from `from` to `to`. */
  remapPrefix: (from: string, to: string) => void;
}

const PERSIST_DEBOUNCE_MS = 250;

export function useTree(args: UseTreeArgs): UseTreeResult {
  const { rootPath, rootEntries, showHidden, sortField, sortDirection, query, enabled } = args;
  const rpc = useFmRpc();

  // Hydrate before the first paint, so there is no collapse-then-expand flash.
  const [state, dispatch] = useReducer(treeReducer, EMPTY_TREE_STATE, (initial) =>
    treeReducer(initial, { type: "hydrate", expanded: readExpanded() }),
  );

  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const nodesRef = useRef(state.nodes);
  nodesRef.current = state.nodes;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Flatten                                                          */
  /* ---------------------------------------------------------------- */

  const flat = useMemo(
    () =>
      flattenTree({
        rootPath,
        rootEntries,
        nodes: state.nodes,
        expanded: state.expanded,
        sortField,
        sortDirection,
        query,
      }),
    [rootPath, rootEntries, state.nodes, state.expanded, sortField, sortDirection, query],
  );

  /* ---------------------------------------------------------------- */
  /* Navigation: re-root the cache                                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    dispatchRef.current({ type: "set-root", path: rootPath });
  }, [rootPath]);

  /* ---------------------------------------------------------------- */
  /* Load loop (§2.2)                                                 */
  /* ---------------------------------------------------------------- */

  const inFlight = useRef(new Set<string>());
  const tickets = useRef(new Map<string, number>());
  const ticketSeq = useRef(0);
  const [loadTick, setLoadTick] = useState(0);

  const startLoad = useCallback(
    (path: string, hidden: boolean) => {
      inFlight.current.add(path);
      const ticket = (ticketSeq.current += 1);
      tickets.current.set(path, ticket);
      dispatchRef.current({ type: "load-start", path, showHidden: hidden });
      void (async () => {
        try {
          const result = await rpc.call("listDir", { path, showHidden: hidden });
          if (mounted.current && tickets.current.get(path) === ticket) {
            dispatchRef.current({
              type: "load-done",
              path,
              entries: result.entries,
              truncated: result.truncated,
              showHidden: hidden,
              atMs: Date.now(),
            });
          }
        } catch (failure) {
          if (mounted.current && tickets.current.get(path) === ticket) {
            dispatchRef.current({ type: "load-failed", path, error: parseRpcError(failure) });
          }
        } finally {
          inFlight.current.delete(path);
          // Only in-flight paths keep a ticket, so `invalidatePaths` can tell
          // "a load is racing this signal" from "nothing to cancel".
          if (tickets.current.get(path) === ticket) tickets.current.delete(path);
          if (mounted.current) setLoadTick((previous) => previous + 1);
        }
      })();
    },
    [rpc],
  );

  useEffect(() => {
    if (!enabled) return;
    const free = LOAD_CONCURRENCY - inFlight.current.size;
    if (free <= 0) return;
    // `flat.rows` is depth-major, so this is breadth-first without a queue: a
    // deep path is not even a candidate until its parent rendered it.
    const candidates: string[] = [];
    for (const row of flat.rows) {
      if (row.kind !== "entry" || !row.expanded) continue;
      const path = row.entry.path;
      if (inFlight.current.has(path)) continue;
      const node = state.nodes.get(normalizePath(path));
      const stale = node === undefined || node.status === "idle" || node.showHidden !== showHidden;
      if (!stale) continue;
      candidates.push(path);
      if (candidates.length >= free) break;
    }
    for (const path of candidates) startLoad(path, showHidden);
  }, [enabled, flat.rows, loadTick, showHidden, startLoad, state.nodes]);

  /* ---------------------------------------------------------------- */
  /* Realtime (§2.4)                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Invalidation has to beat a listing that is already in flight. Without a
   * fresh ticket the stale `load-done` lands *after* the `invalidate`, flips
   * the node from `idle` back to `ready` with pre-mutation entries, and the
   * loader effect then sees nothing stale to refetch: the row shows what the
   * folder held before the upload/move until the user collapses it.
   * `useDirectory` has no such hole — every signal there starts a new load.
   */
  const invalidatePaths = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    const wanted = new Set(paths.map((path) => normalizePath(path)));
    for (const key of [...tickets.current.keys()]) {
      if (wanted.has(normalizePath(key))) tickets.current.set(key, (ticketSeq.current += 1));
    }
    dispatchRef.current({ type: "invalidate", paths: [...paths] });
  }, []);

  const invalidateAll = useCallback(() => {
    for (const key of [...tickets.current.keys()]) {
      tickets.current.set(key, (ticketSeq.current += 1));
    }
    dispatchRef.current({ type: "invalidate-all" });
  }, []);

  const invalidatePathsRef = useRef(invalidatePaths);
  invalidatePathsRef.current = invalidatePaths;

  useRealtime(
    FS_CHANNEL,
    useCallback((payload: unknown) => {
      const paths = (payload as { paths?: unknown } | null)?.paths;
      if (!Array.isArray(paths)) return;
      const hits = paths.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && nodesRef.current.has(normalizePath(candidate)),
      );
      if (hits.length > 0) invalidatePathsRef.current(hits);
    }, []),
  );

  const connectionState = useRealtimeConnectionState();
  const previousConnection = useRef(connectionState);
  useEffect(() => {
    if (connectionState === "connected" && previousConnection.current !== "connected") {
      invalidateAll();
    }
    previousConnection.current = connectionState;
  }, [connectionState, invalidateAll]);

  /* ---------------------------------------------------------------- */
  /* Persistence write-back                                           */
  /* ---------------------------------------------------------------- */

  // Tier 1 is updated synchronously — a remount inside the same page session
  // must never lose an expansion — while tier 2 (localStorage) stays debounced
  // and is flushed on unmount, so a collapse/expand less than 250 ms before the
  // panel goes away still survives a reload (TREE-SPEC §6).
  const pendingWrite = useRef<string[] | null>(null);
  useEffect(() => {
    const paths = Array.from(state.expanded);
    rememberExpanded(paths);
    pendingWrite.current = paths;
    const timer = window.setTimeout(() => {
      pendingWrite.current = null;
      writeExpanded(paths);
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [state.expanded]);

  useEffect(
    () => () => {
      const paths = pendingWrite.current;
      pendingWrite.current = null;
      if (paths !== null) writeExpanded(paths);
    },
    [],
  );

  /* ---------------------------------------------------------------- */
  /* Commands                                                         */
  /* ---------------------------------------------------------------- */

  const send = useCallback((action: TreeAction) => {
    dispatchRef.current(action);
  }, []);

  const expand = useCallback(
    (path: string) => {
      send({ type: "expand", path });
    },
    [send],
  );

  const collapse = useCallback(
    (path: string) => {
      send({ type: "collapse", path });
    },
    [send],
  );

  const collapseAll = useCallback(() => {
    send({ type: "collapse-all" });
  }, [send]);

  const expandedRef = useRef(state.expanded);
  expandedRef.current = state.expanded;

  const isExpanded = useCallback(
    (path: string) => expandedRef.current.has(normalizePath(path)),
    [],
  );

  const toggle = useCallback(
    (entry: FileEntry) => {
      const path = normalizePath(entry.path);
      if (expandedRef.current.has(path)) send({ type: "collapse", path });
      else send({ type: "expand", path });
    },
    [send],
  );

  const nodeEntries = useCallback((path: string): readonly FileEntry[] | null => {
    const node: TreeNode | undefined = nodesRef.current.get(normalizePath(path));
    if (node === undefined || node.loadedAtMs === 0) return null;
    return node.entries;
  }, []);

  const reload = useCallback(
    (path: string) => {
      invalidatePaths([path]);
    },
    [invalidatePaths],
  );

  const refreshAll = useCallback(() => {
    invalidateAll();
  }, [invalidateAll]);

  const pruneSubtree = useCallback(
    (paths: readonly string[]) => {
      if (paths.length === 0) return;
      send({ type: "prune", paths });
    },
    [send],
  );

  const remapPrefix = useCallback(
    (from: string, to: string) => {
      send({ type: "remap", from, to });
    },
    [send],
  );

  return {
    rows: flat.rows,
    visiblePaths: flat.visiblePaths,
    rowsTruncated: flat.truncated,
    expandedCount: state.expanded.size,
    isExpanded,
    toggle,
    expand,
    collapse,
    collapseAll,
    nodeEntries,
    reload,
    refreshAll,
    pruneSubtree,
    remapPrefix,
  };
}
