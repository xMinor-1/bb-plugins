// lib/fm-tree.ts — the tree's data model: a pure reducer and a pure flatten.
//
// Nothing here touches React, the DOM or an RPC client. That is deliberate
// (TREE-SPEC §1.4): every non-trivial transition — pruning a deleted subtree,
// re-keying a rename, evicting past a cap, invalidating on an `fs` signal — is
// unit-testable without a renderer.
//
// Two shapes matter:
//   * `TreeState` = the expanded set + a cache of child listings, keyed by the
//     absolute directory path (the same string every RPC, the drag payload,
//     the clipboard, the selection set and the `fs` signal already speak).
//   * `TreeRow[]` = the flattened, ordered render list. Everything downstream
//     of "an ordered list of visible row paths" (selection, ranges, keyboard,
//     drag & drop) keeps working because that list keeps its shape.
//
// Level 0 — the current directory — is *not* in `nodes`: it stays owned by
// `useDirectory`, and the tree is a layer on top of it.
import { MAX_LIST_ENTRIES, type FileEntry } from "../contract";
import {
  matchesQuery,
  sortEntries,
  type SortDirection,
  type SortField,
} from "../hooks/useDirectory";
import type { ParsedRpcError } from "./errors";
import { isDescendant, isSameOrDescendant, normalizePath } from "./fm-paths";

/* ------------------------------------------------------------------ */
/* Constants (§1.5)                                                    */
/* ------------------------------------------------------------------ */

/** Horizontal indent added per depth level, inside the Name cell only. */
export const INDENT_STEP_PX = 12;
/** Visual clamp: the indent stops growing past this depth (144px). */
export const MAX_INDENT_DEPTH = 12;
/** Rows deeper than this get no chevron — bounds the flatten recursion. */
export const MAX_TREE_DEPTH = 32;
/** Hard cap on flattened rows; the backend caps one listing at the same number. */
export const MAX_TREE_ROWS = MAX_LIST_ENTRIES;
/** How many folders may be open at once (also the persisted array cap). */
export const MAX_EXPANDED_PATHS = 200;
/** LRU bound on cached child listings. */
export const MAX_CACHED_NODES = 256;
/** `listDir` calls in flight at once during a restore. */
export const LOAD_CONCURRENCY = 4;
/** Drag-hover dwell before a collapsed folder springs open. */
export const AUTO_EXPAND_HOVER_MS = 700;
export const EXPANDED_STORAGE_KEY = "bb-plugin-file-manager:expanded:v1";
export const EXPANDED_STORAGE_MAX_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export type TreeNodeStatus = "idle" | "loading" | "ready" | "error";

/** One cached directory listing below the current directory. */
export interface TreeNode {
  /** Absolute directory path. This is the cache key. */
  path: string;
  status: TreeNodeStatus;
  /** Raw `listDir` output for this directory: unsorted, unfiltered. */
  entries: readonly FileEntry[];
  /** `listDir.truncated` for this node. */
  truncated: boolean;
  /** The `showHidden` the entries were fetched with. */
  showHidden: boolean;
  error: ParsedRpcError | null;
  /** 0 until the first successful listing lands. */
  loadedAtMs: number;
}

export interface TreeState {
  /** Absolute paths of folders the user opened. Insertion-ordered. */
  expanded: ReadonlySet<string>;
  /** path → cached child listing. Only holds nodes below the current dir. */
  nodes: ReadonlyMap<string, TreeNode>;
}

export const EMPTY_TREE_STATE: TreeState = {
  expanded: new Set<string>(),
  nodes: new Map<string, TreeNode>(),
};

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

export interface TreeEntryRow {
  kind: "entry";
  /** React key and DOM id: the absolute path. */
  key: string;
  entry: FileEntry;
  /** 0 for a child of the current directory. */
  depth: number;
  /** Absolute path of the directory this row was listed from. */
  parentPath: string;
  /** True for a navigable directory shallower than MAX_TREE_DEPTH. */
  expandable: boolean;
  expanded: boolean;
  /** Its child listing is in flight. */
  loading: boolean;
  /** The cached child listing hit `MAX_LIST_ENTRIES` (§5.9 tooltip). */
  childrenTruncated: boolean;
}

export interface TreeStatusRow {
  kind: "status";
  key: string;
  depth: number;
  parentPath: string;
  status: "empty" | "error";
  /**
   * Human text for the error row, and for the one "empty" case that needs its
   * own wording (an expansion whose children the filter removed); null means
   * the default "Empty folder".
   */
  message: string | null;
}

export type TreeRow = TreeEntryRow | TreeStatusRow;

/**
 * Effective kind of an entry: a symlink is presented as what it points at.
 * Mirrors `components/FileRow.tsx#effectiveKind`; duplicated (three lines) so
 * this module stays free of JSX and of the component graph.
 */
function effectiveKind(entry: FileEntry): FileEntry["kind"] {
  if (entry.isSymlink && entry.targetKind !== null) return entry.targetKind;
  return entry.kind;
}

/** A row is expandable when it is a navigable directory inside the root. */
export function isExpandableEntry(entry: FileEntry, depth: number): boolean {
  if (entry.escapesRoot) return false;
  if (depth >= MAX_TREE_DEPTH) return false;
  return effectiveKind(entry) === "directory";
}

/**
 * Drops every path that already lives inside another path in the same list,
 * and de-duplicates.
 *
 * A batch RPC handed both `docs` and `docs/inner.txt` removes the folder
 * first and then reports `not_found` for the child — a false error toast on
 * an operation that actually succeeded. Before the tree that selection was
 * unreachable (a folder's children were never on screen); with `Ctrl+A` over
 * an expanded folder it is one keystroke away, so the panel normalizes before
 * every batch call (§4.5 of the interaction rules).
 */
export function topLevelPaths(paths: readonly string[]): string[] {
  if (paths.length < 2) return [...paths];
  const selected = new Set(paths.map((path) => normalizePath(path)));
  const hasSelectedAncestor = (key: string): boolean => {
    let current = key;
    for (;;) {
      const index = current.lastIndexOf("/");
      if (index <= 0) return false;
      current = current.slice(0, index);
      if (selected.has(current)) return true;
    }
  };
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const path of paths) {
    const key = normalizePath(path);
    if (seen.has(key) || hasSelectedAncestor(key)) continue;
    seen.add(key);
    kept.push(path);
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* Flatten                                                             */
/* ------------------------------------------------------------------ */

export interface FlattenTreeArgs {
  /** Current directory — the flatten root. Its rows sit at depth 0. */
  rootPath: string;
  /** Level-0 rows, already sorted by `useDirectory`, filter NOT applied. */
  rootEntries: readonly FileEntry[];
  nodes: ReadonlyMap<string, TreeNode>;
  expanded: ReadonlySet<string>;
  sortField: SortField;
  sortDirection: SortDirection;
  /** The toolbar filter; "" (the default) disables filtering. */
  query?: string;
  /** Test seam; defaults to `MAX_TREE_ROWS`. */
  maxRows?: number;
}

export interface FlattenTreeResult {
  rows: TreeRow[];
  /** Paths of the `kind: "entry"` rows, in render order. Feeds `useSelection`. */
  visiblePaths: string[];
  /** True when the flatten hit `maxRows`. */
  truncated: boolean;
}

/** Overwritten in place; never observable from outside `flattenTree`. */
const ROW_PLACEHOLDER: TreeStatusRow = {
  kind: "status",
  key: "",
  depth: 0,
  parentPath: "",
  status: "empty",
  message: null,
};

interface ChildPlan {
  /** Entries to recurse into; empty when there is nothing to render yet. */
  entries: readonly FileEntry[];
  /** The parent row shows a spinner instead of a chevron. */
  loading: boolean;
  /** A status row to emit under the parent instead of children. */
  status: "empty" | "error" | null;
  message: string | null;
}

function planChildren(node: TreeNode | undefined): ChildPlan {
  if (node === undefined) {
    return { entries: [], loading: true, status: null, message: null };
  }
  if (node.status === "error") {
    return {
      entries: [],
      loading: false,
      status: "error",
      message: node.error === null ? "Could not open this folder." : errorText(node.error),
    };
  }
  const cold = node.loadedAtMs === 0;
  if (cold && (node.status === "idle" || node.status === "loading")) {
    return { entries: [], loading: true, status: null, message: null };
  }
  // A refetch over existing data keeps rendering it (no flicker), exactly like
  // `useDirectory`'s background refresh.
  const loading = node.status !== "ready";
  if (node.entries.length === 0) {
    return { entries: [], loading, status: "empty", message: null };
  }
  return { entries: node.entries, loading, status: null, message: null };
}

function errorText(error: ParsedRpcError): string {
  const message = error.message.trim();
  if (message !== "") return message;
  const raw = error.rawMessage.trim();
  return raw === "" ? "Could not open this folder." : raw;
}

/**
 * Depth-first flatten of the current listing plus every expanded, cached
 * child listing. Sorting is applied per parent (§5.8) and the filter is
 * applied to every level it walks, keeping a folder whose own name does not
 * match when something inside it does (§5.7).
 */
export function flattenTree(args: FlattenTreeArgs): FlattenTreeResult {
  const { rootPath, rootEntries, nodes, expanded, sortField, sortDirection } = args;
  const query = args.query ?? "";
  const maxRows = args.maxRows ?? MAX_TREE_ROWS;
  const filtering = query.trim() !== "";

  const rows: TreeRow[] = [];
  let truncated = false;

  const pushStatus = (row: TreeStatusRow): void => {
    if (rows.length >= maxRows) {
      truncated = true;
      return;
    }
    rows.push(row);
  };

  /** Appends the rows of one directory level; returns true when any survived. */
  const build = (parentPath: string, entries: readonly FileEntry[], depth: number): boolean => {
    let matchedAny = false;
    for (const entry of entries) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const selfMatch = !filtering || matchesQuery(entry, query);
      const expandable = isExpandableEntry(entry, depth);
      const isOpen = expandable && expanded.has(normalizePath(entry.path));

      // Reserve the parent's slot so children can be appended after it while
      // the decision to keep it still depends on what they produced.
      const slot = rows.length;
      rows.push(ROW_PLACEHOLDER);

      let loading = false;
      let childrenTruncated = false;
      let childMatched = false;
      let filteredOut = false;

      if (isOpen) {
        const node = nodes.get(normalizePath(entry.path));
        const plan = planChildren(node);
        loading = plan.loading;
        childrenTruncated = node?.truncated ?? false;
        if (plan.status !== null) {
          pushStatus({
            kind: "status",
            key: `${plan.status}:${entry.path}`,
            depth: depth + 1,
            parentPath: entry.path,
            status: plan.status,
            message: plan.message,
          });
        } else if (plan.entries.length > 0) {
          const sorted = sortEntries(plan.entries, sortField, sortDirection, {
            foldersFirst: true,
          });
          childMatched = build(entry.path, sorted, depth + 1);
          // The listing arrived and the filter ate all of it. Without a row of
          // its own the folder would answer the click with nothing but a
          // turned chevron — the silent no-op §1.2 forbids.
          filteredOut = filtering && !childMatched;
        }
      }

      if (!selfMatch && !childMatched) {
        // Drop the folder and everything the recursion appended under it.
        rows.length = slot;
        continue;
      }

      rows[slot] = {
        kind: "entry",
        key: entry.path,
        entry,
        depth,
        parentPath,
        expandable,
        expanded: isOpen,
        loading,
        childrenTruncated,
      };
      matchedAny = true;

      if (filteredOut) {
        pushStatus({
          kind: "status",
          key: `filtered:${entry.path}`,
          depth: depth + 1,
          parentPath: entry.path,
          status: "empty",
          message: "Nothing in here matches the filter",
        });
      }
    }
    return matchedAny;
  };

  build(rootPath, rootEntries, 0);

  const visiblePaths: string[] = [];
  for (const row of rows) if (row.kind === "entry") visiblePaths.push(row.entry.path);

  return { rows, visiblePaths, truncated };
}

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

export type TreeAction =
  | { type: "hydrate"; expanded: readonly string[] }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "collapse-all" }
  | { type: "load-start"; path: string; showHidden: boolean }
  | {
      type: "load-done";
      path: string;
      entries: readonly FileEntry[];
      truncated: boolean;
      showHidden: boolean;
      atMs: number;
    }
  | { type: "load-failed"; path: string; error: ParsedRpcError }
  | { type: "invalidate"; paths: readonly string[] }
  | { type: "invalidate-all" }
  | { type: "prune"; paths: readonly string[] }
  | { type: "remap"; from: string; to: string }
  | { type: "set-root"; path: string };

/**
 * Drops the least-recently-loaded *collapsed* nodes until the cache fits.
 * Expanded nodes are never evicted — they are on screen.
 */
function capNodes(
  nodes: ReadonlyMap<string, TreeNode>,
  expanded: ReadonlySet<string>,
): ReadonlyMap<string, TreeNode> {
  if (nodes.size <= MAX_CACHED_NODES) return nodes;
  const victims = Array.from(nodes.values())
    .filter((node) => !expanded.has(node.path))
    .sort((a, b) => a.loadedAtMs - b.loadedAtMs);
  const next = new Map(nodes);
  for (const victim of victims) {
    if (next.size <= MAX_CACHED_NODES) break;
    next.delete(victim.path);
  }
  return next;
}

/** `expand` eviction: oldest first, never an ancestor of the path just opened. */
function capExpanded(expanded: Set<string>, keep: string): Set<string> {
  while (expanded.size > MAX_EXPANDED_PATHS) {
    let victim: string | null = null;
    for (const candidate of expanded) {
      if (candidate === keep) continue;
      if (isDescendant(keep, candidate)) continue; // candidate is an ancestor
      victim = candidate;
      break;
    }
    if (victim === null) break;
    expanded.delete(victim);
  }
  return expanded;
}

function withNode(
  state: TreeState,
  path: string,
  update: (previous: TreeNode | undefined) => TreeNode,
): TreeState {
  const key = normalizePath(path);
  const nodes = new Map(state.nodes);
  nodes.set(key, update(state.nodes.get(key)));
  return { expanded: state.expanded, nodes };
}

function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return `${to}${path.slice(from.length)}`;
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Rewrites the absolute paths a cached listing carries after a rename. */
function remapEntries(
  entries: readonly FileEntry[],
  from: string,
  to: string,
): readonly FileEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    const path = normalizePath(entry.path);
    if (!isSameOrDescendant(path, from)) return entry;
    changed = true;
    const remapped = remapPath(path, from, to);
    return path === from
      ? { ...entry, path: remapped, name: baseNameOf(to) }
      : { ...entry, path: remapped };
  });
  return changed ? next : entries;
}

export function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case "hydrate": {
      const paths = action.expanded
        .filter((path) => typeof path === "string" && path !== "")
        .map((path) => normalizePath(path));
      const expanded = new Set(paths.slice(-MAX_EXPANDED_PATHS));
      if (expanded.size === 0 && state.expanded.size === 0) return state;
      return { expanded, nodes: state.nodes };
    }

    case "expand": {
      const path = normalizePath(action.path);
      if (state.expanded.has(path)) return state;
      const expanded = capExpanded(new Set(state.expanded).add(path), path);
      return { expanded, nodes: state.nodes };
    }

    case "collapse": {
      const path = normalizePath(action.path);
      if (!state.expanded.has(path)) return state;
      const expanded = new Set(state.expanded);
      expanded.delete(path);
      // Descendants deliberately stay expanded: re-opening restores the shape.
      return { expanded, nodes: state.nodes };
    }

    case "collapse-all": {
      if (state.expanded.size === 0) return state;
      return { expanded: new Set<string>(), nodes: state.nodes };
    }

    case "load-start":
      return withNode(state, action.path, (previous) => ({
        path: normalizePath(action.path),
        status: "loading",
        entries: previous?.entries ?? [],
        truncated: previous?.truncated ?? false,
        showHidden: action.showHidden,
        error: null,
        loadedAtMs: previous?.loadedAtMs ?? 0,
      }));

    case "load-done": {
      const next = withNode(state, action.path, () => ({
        path: normalizePath(action.path),
        status: "ready",
        entries: action.entries,
        truncated: action.truncated,
        showHidden: action.showHidden,
        error: null,
        loadedAtMs: action.atMs,
      }));
      return { expanded: next.expanded, nodes: capNodes(next.nodes, next.expanded) };
    }

    case "load-failed":
      return withNode(state, action.path, (previous) => ({
        path: normalizePath(action.path),
        status: "error",
        entries: previous?.entries ?? [],
        truncated: previous?.truncated ?? false,
        showHidden: previous?.showHidden ?? false,
        error: action.error,
        loadedAtMs: previous?.loadedAtMs ?? 0,
      }));

    case "invalidate": {
      let nodes: Map<string, TreeNode> | null = null;
      for (const raw of action.paths) {
        const path = normalizePath(raw);
        const node = state.nodes.get(path);
        if (node === undefined || node.status === "idle") continue;
        nodes ??= new Map(state.nodes);
        // Keep `entries` so the refetch re-renders without flicker.
        nodes.set(path, { ...node, status: "idle", error: null });
      }
      return nodes === null ? state : { expanded: state.expanded, nodes };
    }

    case "invalidate-all": {
      if (state.nodes.size === 0) return state;
      let changed = false;
      const nodes = new Map<string, TreeNode>();
      for (const [path, node] of state.nodes) {
        if (node.status === "idle") {
          nodes.set(path, node);
          continue;
        }
        changed = true;
        nodes.set(path, { ...node, status: "idle", error: null });
      }
      return changed ? { expanded: state.expanded, nodes } : state;
    }

    case "prune": {
      const roots = action.paths.map((path) => normalizePath(path));
      if (roots.length === 0) return state;
      const hit = (candidate: string): boolean =>
        roots.some((root) => isSameOrDescendant(candidate, root));

      let expanded = state.expanded;
      const keptExpanded = new Set<string>();
      let expandedChanged = false;
      for (const path of state.expanded) {
        if (hit(path)) expandedChanged = true;
        else keptExpanded.add(path);
      }
      if (expandedChanged) expanded = keptExpanded;

      let nodes = state.nodes;
      const keptNodes = new Map<string, TreeNode>();
      let nodesChanged = false;
      for (const [path, node] of state.nodes) {
        if (hit(path)) nodesChanged = true;
        else keptNodes.set(path, node);
      }
      if (nodesChanged) nodes = keptNodes;

      if (!expandedChanged && !nodesChanged) return state;
      return { expanded, nodes };
    }

    case "remap": {
      const from = normalizePath(action.from);
      const to = normalizePath(action.to);
      if (from === to) return state;

      const expanded = new Set<string>();
      let expandedChanged = false;
      for (const path of state.expanded) {
        if (isSameOrDescendant(path, from)) {
          expanded.add(remapPath(path, from, to));
          expandedChanged = true;
        } else {
          expanded.add(path);
        }
      }

      const nodes = new Map<string, TreeNode>();
      let nodesChanged = false;
      for (const [path, node] of state.nodes) {
        const entries = remapEntries(node.entries, from, to);
        if (!isSameOrDescendant(path, from)) {
          if (entries === node.entries) {
            nodes.set(path, node);
          } else {
            nodesChanged = true;
            nodes.set(path, { ...node, entries });
          }
          continue;
        }
        const key = remapPath(path, from, to);
        nodesChanged = true;
        nodes.set(key, { ...node, path: key, entries });
      }

      if (!expandedChanged && !nodesChanged) return state;
      return {
        expanded: expandedChanged ? expanded : state.expanded,
        nodes: nodesChanged ? nodes : state.nodes,
      };
    }

    case "set-root": {
      const root = normalizePath(action.path);
      const kept = new Map<string, TreeNode>();
      let changed = false;
      for (const [path, node] of state.nodes) {
        // Keep what is still reachable from the new location: the subtree
        // under it, and the ancestors the user can walk back up into.
        if (isSameOrDescendant(path, root) || isDescendant(root, path)) kept.set(path, node);
        else changed = true;
      }
      const nodes = capNodes(changed ? kept : state.nodes, state.expanded);
      if (nodes === state.nodes) return state;
      return { expanded: state.expanded, nodes };
    }

    default:
      return state;
  }
}
