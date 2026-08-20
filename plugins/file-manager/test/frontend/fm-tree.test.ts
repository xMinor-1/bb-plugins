// TREE-SPEC §8.1 — `lib/fm-tree.ts` on its own: the flatten and the reducer.
//
// No DOM, no React, no RPC. That is the whole point of keeping both pure
// (TREE-SPEC §1.4): pruning a deleted subtree, re-keying a rename, evicting
// past a cap and invalidating on an `fs` signal are testable here, once, at the
// only layer that decides them.
import { describe, expect, it } from "vitest";

import { MAX_LIST_ENTRIES, type FileEntry } from "../../contract";
import type { ParsedRpcError } from "../../lib/errors";
import {
  EMPTY_TREE_STATE,
  MAX_CACHED_NODES,
  MAX_EXPANDED_PATHS,
  MAX_TREE_DEPTH,
  MAX_TREE_ROWS,
  flattenTree,
  isExpandableEntry,
  topLevelPaths,
  treeReducer,
  type FlattenTreeArgs,
  type TreeEntryRow,
  type TreeNode,
  type TreeRow,
  type TreeState,
} from "../../lib/fm-tree";

const ROOT = "/home/coder";
const DOCS = `${ROOT}/docs`;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function file(name: string, path = `${ROOT}/${name}`, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path,
    kind: "file",
    targetKind: null,
    sizeBytes: 1,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: name.startsWith("."),
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
    ...overrides,
  };
}

function dir(name: string, path = `${ROOT}/${name}`, overrides: Partial<FileEntry> = {}): FileEntry {
  return file(name, path, { kind: "directory", ...overrides });
}

function node(path: string, entries: readonly FileEntry[], overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    path,
    status: "ready",
    entries,
    truncated: false,
    showHidden: false,
    error: null,
    loadedAtMs: 1_000,
    ...overrides,
  };
}

function nodesOf(...list: readonly TreeNode[]): Map<string, TreeNode> {
  return new Map(list.map((candidate) => [candidate.path, candidate]));
}

function flatten(overrides: Partial<FlattenTreeArgs> & { rootEntries: readonly FileEntry[] }) {
  return flattenTree({
    rootPath: ROOT,
    nodes: new Map<string, TreeNode>(),
    expanded: new Set<string>(),
    sortField: "name",
    sortDirection: "asc",
    ...overrides,
  });
}

/** `path@depth` for every row — the one string that describes a flattened tree. */
function shape(rows: readonly TreeRow[]): string[] {
  return rows.map((row) =>
    row.kind === "entry"
      ? `${row.entry.path}@${String(row.depth)}`
      : `<${row.status}:${row.parentPath}>@${String(row.depth)}`,
  );
}

function entryRow(rows: readonly TreeRow[], path: string): TreeEntryRow {
  const found = rows.find((row): row is TreeEntryRow => row.kind === "entry" && row.entry.path === path);
  if (found === undefined) throw new Error(`no row for ${path}; saw ${shape(rows).join(", ")}`);
  return found;
}

const NOTES = file("notes.txt");
const ZETA = file("zeta.txt");
const DOCS_DIR = dir("docs", DOCS);
const INNER = file("inner.txt", `${DOCS}/inner.txt`);
const NESTED = dir("nested", `${DOCS}/nested`);
const DEEP = file("deep.txt", `${DOCS}/nested/deep.txt`);

const PERMISSION_DENIED: ParsedRpcError = {
  code: "permission_denied",
  message: "Permission denied.",
  rawMessage: "permission_denied",
  wireCode: "handler_error",
};

/* ------------------------------------------------------------------ */
/* flattenTree                                                         */
/* ------------------------------------------------------------------ */

describe("flattenTree (§8.1)", () => {
  it("returns the level-0 entries at depth 0 when nothing is expanded", () => {
    const result = flatten({ rootEntries: [DOCS_DIR, NOTES, ZETA] });

    expect(shape(result.rows)).toEqual([`${DOCS}@0`, `${ROOT}/notes.txt@0`, `${ROOT}/zeta.txt@0`]);
    expect(result.rows.every((row) => row.depth === 0)).toBe(true);
    expect(result.truncated).toBe(false);
    expect(entryRow(result.rows, DOCS).expandable).toBe(true);
    expect(entryRow(result.rows, DOCS).expanded).toBe(false);
    expect(entryRow(result.rows, NOTES.path).expandable).toBe(false);
  });

  it("splices the children of an expanded folder in before its next sibling", () => {
    const result = flatten({
      rootEntries: [DOCS_DIR, NOTES, ZETA],
      nodes: nodesOf(node(DOCS, [INNER])),
      expanded: new Set([DOCS]),
    });

    expect(shape(result.rows)).toEqual([
      `${DOCS}@0`,
      `${DOCS}/inner.txt@1`,
      `${ROOT}/notes.txt@0`,
      `${ROOT}/zeta.txt@0`,
    ]);
    const parent = entryRow(result.rows, DOCS);
    expect(parent.expanded).toBe(true);
    expect(parent.loading).toBe(false);
    expect(entryRow(result.rows, INNER.path).parentPath).toBe(DOCS);
  });

  it("sorts every level on its own, folders first, whatever order the node arrived in", () => {
    const result = flatten({
      rootEntries: [DOCS_DIR, NOTES],
      // Deliberately unsorted, as `listDir` may return it.
      nodes: nodesOf(node(DOCS, [file("z.txt", `${DOCS}/z.txt`), NESTED, INNER])),
      expanded: new Set([DOCS]),
    });

    expect(shape(result.rows)).toEqual([
      `${DOCS}@0`,
      `${DOCS}/nested@1`,
      `${DOCS}/inner.txt@1`,
      `${DOCS}/z.txt@1`,
      `${ROOT}/notes.txt@0`,
    ]);
  });

  it("keeps sorting per parent when a grandchild is expanded too", () => {
    const result = flatten({
      rootEntries: [DOCS_DIR, NOTES],
      nodes: nodesOf(node(DOCS, [INNER, NESTED]), node(NESTED.path, [DEEP])),
      expanded: new Set([DOCS, NESTED.path]),
    });

    expect(shape(result.rows)).toEqual([
      `${DOCS}@0`,
      `${DOCS}/nested@1`,
      `${DOCS}/nested/deep.txt@2`,
      `${DOCS}/inner.txt@1`,
      `${ROOT}/notes.txt@0`,
    ]);
  });

  it("emits no child rows and marks the parent loading while the node is missing or cold", () => {
    const missing = flatten({
      rootEntries: [DOCS_DIR],
      expanded: new Set([DOCS]),
    });
    expect(shape(missing.rows)).toEqual([`${DOCS}@0`]);
    expect(entryRow(missing.rows, DOCS).loading).toBe(true);

    const cold = flatten({
      rootEntries: [DOCS_DIR],
      nodes: nodesOf(node(DOCS, [], { status: "loading", loadedAtMs: 0 })),
      expanded: new Set([DOCS]),
    });
    expect(shape(cold.rows)).toEqual([`${DOCS}@0`]);
    expect(entryRow(cold.rows, DOCS).loading).toBe(true);
  });

  it("keeps rendering stale children during a refetch instead of flickering", () => {
    const result = flatten({
      rootEntries: [DOCS_DIR],
      nodes: nodesOf(node(DOCS, [INNER], { status: "loading" })),
      expanded: new Set([DOCS]),
    });

    expect(shape(result.rows)).toEqual([`${DOCS}@0`, `${DOCS}/inner.txt@1`]);
    expect(entryRow(result.rows, DOCS).loading).toBe(true);
  });

  it("emits one empty status row for an expanded folder that really is empty", () => {
    const result = flatten({
      rootEntries: [DOCS_DIR],
      nodes: nodesOf(node(DOCS, [])),
      expanded: new Set([DOCS]),
    });

    expect(shape(result.rows)).toEqual([`${DOCS}@0`, `<empty:${DOCS}>@1`]);
    const status = result.rows[1];
    expect(status?.kind).toBe("status");
    if (status?.kind === "status") {
      expect(status.status).toBe("empty");
      expect(status.message).toBeNull();
      expect(status.parentPath).toBe(DOCS);
    }
  });

  it("emits one error status row carrying the parsed message", () => {
    const result = flatten({
      rootEntries: [DOCS_DIR],
      nodes: nodesOf(node(DOCS, [], { status: "error", loadedAtMs: 0, error: PERMISSION_DENIED })),
      expanded: new Set([DOCS]),
    });

    expect(shape(result.rows)).toEqual([`${DOCS}@0`, `<error:${DOCS}>@1`]);
    const status = result.rows[1];
    if (status?.kind !== "status") throw new Error("expected a status row");
    expect(status.status).toBe("error");
    expect(status.message).toBe("Permission denied.");
    // The chevron stops spinning: a failed node is settled, not in flight.
    expect(entryRow(result.rows, DOCS).loading).toBe(false);
  });

  it("falls back to a sentence when the failure carried no message at all", () => {
    const blank: ParsedRpcError = { code: null, message: "", rawMessage: "", wireCode: null };
    const result = flatten({
      rootEntries: [DOCS_DIR],
      nodes: nodesOf(node(DOCS, [], { status: "error", loadedAtMs: 0, error: blank })),
      expanded: new Set([DOCS]),
    });

    const status = result.rows[1];
    if (status?.kind !== "status") throw new Error("expected a status row");
    expect(status.message).toBe("Could not open this folder.");
  });

  it("keeps the ancestor of a filtered match and drops the siblings that miss", () => {
    const result = flatten({
      rootEntries: [DOCS_DIR, NOTES, ZETA],
      nodes: nodesOf(node(DOCS, [INNER, file("other.log", `${DOCS}/other.log`)])),
      expanded: new Set([DOCS]),
      query: "inner",
    });

    expect(shape(result.rows)).toEqual([`${DOCS}@0`, `${DOCS}/inner.txt@1`]);
  });

  it("drops an expanded folder whose subtree matches nothing, unless its own name matches", () => {
    const args = {
      rootEntries: [DOCS_DIR, NOTES],
      nodes: nodesOf(node(DOCS, [INNER])),
      expanded: new Set([DOCS]),
    };

    expect(shape(flatten({ ...args, query: "notes" }).rows)).toEqual([`${ROOT}/notes.txt@0`]);
    // The folder's own name matches, so its row survives — but §5.7 applies
    // `matchesQuery` at *every* level it walks, so a child that misses is
    // still dropped. §1.2 then owes the user a reason, or the expansion is a
    // silent no-op: an open folder with no rows under it.
    const filtered = flatten({ ...args, query: "docs" });
    expect(shape(filtered.rows)).toEqual([`${DOCS}@0`, `<empty:${DOCS}>@1`]);
    expect(filtered.rows[1]).toMatchObject({ message: "Nothing in here matches the filter" });
    expect(filtered.visiblePaths).toEqual([DOCS]);
  });

  it("lists only entry rows in visiblePaths, in render order, never a status row", () => {
    const empty = dir("empty", `${ROOT}/empty`);
    const result = flatten({
      rootEntries: [DOCS_DIR, empty, NOTES],
      nodes: nodesOf(node(DOCS, [INNER]), node(empty.path, [])),
      expanded: new Set([DOCS, empty.path]),
    });

    expect(shape(result.rows)).toEqual([
      `${DOCS}@0`,
      `${DOCS}/inner.txt@1`,
      `${ROOT}/empty@0`,
      `<empty:${ROOT}/empty>@1`,
      `${ROOT}/notes.txt@0`,
    ]);
    expect(result.visiblePaths).toEqual([DOCS, INNER.path, empty.path, NOTES.path]);
  });

  it("stops at MAX_TREE_ROWS and reports the truncation", () => {
    const many = Array.from({ length: MAX_TREE_ROWS + 1 }, (_unused, index) =>
      file(`f${String(index).padStart(5, "0")}.txt`),
    );
    const result = flatten({ rootEntries: many });

    expect(MAX_TREE_ROWS).toBe(MAX_LIST_ENTRIES);
    expect(result.rows).toHaveLength(MAX_TREE_ROWS);
    expect(result.visiblePaths).toHaveLength(MAX_TREE_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("eats the bottom of the list, not a random middle, when the cap bites", () => {
    // Same rule at a testable size via the `maxRows` seam: depth-first order
    // means the rows that survive are the ones nearest the top.
    const result = flatten({
      rootEntries: [DOCS_DIR, NOTES, ZETA],
      nodes: nodesOf(node(DOCS, [INNER, NESTED])),
      expanded: new Set([DOCS]),
      maxRows: 3,
    });

    expect(shape(result.rows)).toEqual([`${DOCS}@0`, `${DOCS}/nested@1`, `${DOCS}/inner.txt@1`]);
    expect(result.truncated).toBe(true);
  });

  it("removes the chevron at MAX_TREE_DEPTH, which is what bounds the recursion", () => {
    const chain: FileEntry[] = [];
    let parent = ROOT;
    for (let depth = 0; depth <= MAX_TREE_DEPTH; depth += 1) {
      const path = `${parent}/d${String(depth)}`;
      chain.push(dir(`d${String(depth)}`, path));
      parent = path;
    }
    const nodes = new Map<string, TreeNode>();
    const expanded = new Set<string>();
    for (let index = 0; index < chain.length - 1; index += 1) {
      const current = chain[index]!;
      nodes.set(current.path, node(current.path, [chain[index + 1]!]));
      expanded.add(current.path);
    }

    const result = flatten({ rootEntries: [chain[0]!], nodes, expanded });

    expect(result.rows).toHaveLength(MAX_TREE_DEPTH + 1);
    const deepest = entryRow(result.rows, chain[MAX_TREE_DEPTH]!.path);
    expect(deepest.depth).toBe(MAX_TREE_DEPTH);
    expect(deepest.expandable).toBe(false);
    expect(entryRow(result.rows, chain[MAX_TREE_DEPTH - 1]!.path).expandable).toBe(true);
  });

  it("expands a symlink that points at a directory inside the root, never one that leaves it", () => {
    const inside = dir("link-in", `${ROOT}/link-in`, {
      kind: "symlink",
      targetKind: "directory",
      isSymlink: true,
    });
    const outside = dir("link-out", `${ROOT}/link-out`, {
      kind: "symlink",
      targetKind: "directory",
      isSymlink: true,
      escapesRoot: true,
    });

    const result = flatten({ rootEntries: [inside, outside] });

    expect(entryRow(result.rows, inside.path).expandable).toBe(true);
    expect(entryRow(result.rows, outside.path).expandable).toBe(false);
    expect(isExpandableEntry(inside, 0)).toBe(true);
    expect(isExpandableEntry(outside, 0)).toBe(false);
    expect(isExpandableEntry(inside, MAX_TREE_DEPTH)).toBe(false);
  });

  it("carries the child listing's truncation onto the folder row for its tooltip", () => {
    const result = flatten({
      rootEntries: [DOCS_DIR],
      nodes: nodesOf(node(DOCS, [INNER], { truncated: true })),
      expanded: new Set([DOCS]),
    });

    expect(entryRow(result.rows, DOCS).childrenTruncated).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* topLevelPaths (§4.5 / §8.7 of the interaction rules)                */
/* ------------------------------------------------------------------ */

describe("topLevelPaths", () => {
  it("drops a path that already lives inside another selected path", () => {
    expect(topLevelPaths([DOCS, INNER.path, NOTES.path])).toEqual([DOCS, NOTES.path]);
  });

  it("is prefix-safe: /a/docs never swallows /a/docs2", () => {
    expect(topLevelPaths([DOCS, `${ROOT}/docs2/inner.txt`])).toEqual([
      DOCS,
      `${ROOT}/docs2/inner.txt`,
    ]);
  });

  it("de-duplicates and keeps the caller's order", () => {
    expect(topLevelPaths([ZETA.path, NOTES.path, ZETA.path])).toEqual([ZETA.path, NOTES.path]);
  });

  it("passes a single path through untouched", () => {
    expect(topLevelPaths([INNER.path])).toEqual([INNER.path]);
    expect(topLevelPaths([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* treeReducer                                                         */
/* ------------------------------------------------------------------ */

function expandedOf(state: TreeState): string[] {
  return Array.from(state.expanded);
}

describe("treeReducer (§8.1)", () => {
  it("returns the identical state when expanding an already expanded path", () => {
    const opened = treeReducer(EMPTY_TREE_STATE, { type: "expand", path: DOCS });
    expect(expandedOf(opened)).toEqual([DOCS]);

    const again = treeReducer(opened, { type: "expand", path: DOCS });
    expect(again).toBe(opened);
  });

  it("evicts the oldest non-ancestor when expand passes MAX_EXPANDED_PATHS", () => {
    let state = EMPTY_TREE_STATE;
    for (let index = 0; index < MAX_EXPANDED_PATHS; index += 1) {
      state = treeReducer(state, { type: "expand", path: `${ROOT}/p${String(index)}` });
    }
    expect(state.expanded.size).toBe(MAX_EXPANDED_PATHS);

    // The oldest entry is also the new path's parent: evicting it would close
    // the folder the user just opened something inside.
    const child = `${ROOT}/p0/child`;
    state = treeReducer(state, { type: "expand", path: child });

    expect(state.expanded.size).toBe(MAX_EXPANDED_PATHS);
    expect(state.expanded.has(child)).toBe(true);
    expect(state.expanded.has(`${ROOT}/p0`)).toBe(true);
    expect(state.expanded.has(`${ROOT}/p1`)).toBe(false);
  });

  it("keeps descendants expanded on collapse, so re-opening restores the shape", () => {
    let state = treeReducer(EMPTY_TREE_STATE, { type: "expand", path: DOCS });
    state = treeReducer(state, { type: "expand", path: NESTED.path });

    const collapsed = treeReducer(state, { type: "collapse", path: DOCS });
    expect(collapsed.expanded.has(DOCS)).toBe(false);
    expect(collapsed.expanded.has(NESTED.path)).toBe(true);

    const reopened = treeReducer(collapsed, { type: "expand", path: DOCS });
    expect(new Set(expandedOf(reopened))).toEqual(new Set([DOCS, NESTED.path]));

    // Collapsing something that was never open changes nothing at all.
    expect(treeReducer(reopened, { type: "collapse", path: `${ROOT}/pics` })).toBe(reopened);
  });

  it("collapse-all empties the set once and is then identity-stable", () => {
    const state = treeReducer(EMPTY_TREE_STATE, { type: "expand", path: DOCS });
    const cleared = treeReducer(state, { type: "collapse-all" });

    expect(cleared.expanded.size).toBe(0);
    expect(cleared.nodes).toBe(state.nodes);
    expect(treeReducer(cleared, { type: "collapse-all" })).toBe(cleared);
  });

  it("prunes a path, its descendants and their nodes — and leaves /docs2 alone", () => {
    const docs2 = `${ROOT}/docs2`;
    let state: TreeState = {
      expanded: new Set([DOCS, NESTED.path, docs2]),
      nodes: nodesOf(
        node(DOCS, [INNER, NESTED]),
        node(NESTED.path, [DEEP]),
        node(docs2, [file("keep.txt", `${docs2}/keep.txt`)]),
      ),
    };

    state = treeReducer(state, { type: "prune", paths: [DOCS] });

    expect(expandedOf(state)).toEqual([docs2]);
    expect(Array.from(state.nodes.keys())).toEqual([docs2]);
  });

  it("re-keys nodes, entries and expansions on remap, prefix-safe", () => {
    const docs2 = `${ROOT}/docs2`;
    const renamed = `${ROOT}/manuals`;
    const state: TreeState = {
      expanded: new Set([DOCS, NESTED.path, docs2]),
      nodes: nodesOf(node(DOCS, [INNER, NESTED]), node(NESTED.path, [DEEP]), node(docs2, [])),
    };

    const next = treeReducer(state, { type: "remap", from: DOCS, to: renamed });

    expect(new Set(expandedOf(next))).toEqual(new Set([renamed, `${renamed}/nested`, docs2]));
    expect(new Set(next.nodes.keys())).toEqual(new Set([renamed, `${renamed}/nested`, docs2]));
    expect(next.nodes.get(renamed)?.entries.map((entry) => entry.path)).toEqual([
      `${renamed}/inner.txt`,
      `${renamed}/nested`,
    ]);
    expect(next.nodes.get(`${renamed}/nested`)?.entries.map((entry) => entry.path)).toEqual([
      `${renamed}/nested/deep.txt`,
    ]);
    // The renamed folder's own row, listed by its parent, is re-keyed too.
    const parent = treeReducer(
      { expanded: new Set<string>(), nodes: nodesOf(node(ROOT, [DOCS_DIR, NOTES])) },
      { type: "remap", from: DOCS, to: renamed },
    );
    const rootEntries = parent.nodes.get(ROOT)?.entries ?? [];
    expect(rootEntries.map((entry) => `${entry.name}:${entry.path}`)).toEqual([
      `manuals:${renamed}`,
      `notes.txt:${NOTES.path}`,
    ]);
  });

  it("invalidate keeps the cached entries and only flips the status to idle", () => {
    const state: TreeState = {
      expanded: new Set([DOCS]),
      nodes: nodesOf(node(DOCS, [INNER]), node(`${ROOT}/pics`, [])),
    };

    const next = treeReducer(state, { type: "invalidate", paths: [DOCS, `${ROOT}/never-listed`] });

    expect(next.nodes.get(DOCS)?.status).toBe("idle");
    expect(next.nodes.get(DOCS)?.entries).toEqual([INNER]);
    expect(next.nodes.get(DOCS)?.error).toBeNull();
    // An untouched node keeps its identity, so the memo below it does not run.
    expect(next.nodes.get(`${ROOT}/pics`)).toBe(state.nodes.get(`${ROOT}/pics`));
    // Nothing named a cached node → the state object itself is unchanged.
    expect(treeReducer(state, { type: "invalidate", paths: [`${ROOT}/elsewhere`] })).toBe(state);
  });

  it("invalidate-all marks every cached node stale in one go", () => {
    const state: TreeState = {
      expanded: new Set([DOCS]),
      nodes: nodesOf(node(DOCS, [INNER]), node(`${ROOT}/pics`, [])),
    };

    const next = treeReducer(state, { type: "invalidate-all" });
    expect(Array.from(next.nodes.values()).map((candidate) => candidate.status)).toEqual([
      "idle",
      "idle",
    ]);
    expect(next.nodes.get(DOCS)?.entries).toEqual([INNER]);
    expect(treeReducer(next, { type: "invalidate-all" })).toBe(next);
  });

  it("set-root keeps the new subtree and the ancestors, and drops the rest", () => {
    const state: TreeState = {
      expanded: new Set<string>(),
      nodes: nodesOf(node(ROOT, []), node(`${DOCS}/nested`, []), node(`${ROOT}/pics`, [])),
    };

    const next = treeReducer(state, { type: "set-root", path: DOCS });

    expect(new Set(next.nodes.keys())).toEqual(new Set([ROOT, `${DOCS}/nested`]));
  });

  it("set-root applies the MAX_CACHED_NODES LRU to collapsed nodes only", () => {
    const nodes = new Map<string, TreeNode>();
    const oldestExpanded = `${ROOT}/pinned`;
    nodes.set(oldestExpanded, node(oldestExpanded, [], { loadedAtMs: 1 }));
    for (let index = 0; index < MAX_CACHED_NODES + 50; index += 1) {
      const path = `${ROOT}/bulk${String(index)}`;
      nodes.set(path, node(path, [], { loadedAtMs: 100 + index }));
    }
    const state: TreeState = { expanded: new Set([oldestExpanded]), nodes };

    const next = treeReducer(state, { type: "set-root", path: ROOT });

    expect(next.nodes.size).toBe(MAX_CACHED_NODES);
    // On screen, therefore never a victim, even though it is the oldest.
    expect(next.nodes.has(oldestExpanded)).toBe(true);
    expect(next.nodes.has(`${ROOT}/bulk0`)).toBe(false);
    expect(next.nodes.has(`${ROOT}/bulk${String(MAX_CACHED_NODES + 49)}`)).toBe(true);
  });

  it("hydrate drops non-strings and keeps at most MAX_EXPANDED_PATHS paths", () => {
    const stored = Array.from({ length: MAX_EXPANDED_PATHS + 5 }, (_unused, index) =>
      `${ROOT}/h${String(index)}`,
    );
    const state = treeReducer(EMPTY_TREE_STATE, { type: "hydrate", expanded: stored });

    expect(state.expanded.size).toBe(MAX_EXPANDED_PATHS);
    expect(state.expanded.has(`${ROOT}/h0`)).toBe(false);
    expect(state.expanded.has(`${ROOT}/h${String(MAX_EXPANDED_PATHS + 4)}`)).toBe(true);
    // An empty hydrate over an empty tree must not churn the state object.
    expect(treeReducer(EMPTY_TREE_STATE, { type: "hydrate", expanded: [] })).toBe(EMPTY_TREE_STATE);
  });

  it("load-start / load-done / load-failed move one node through its lifecycle", () => {
    let state = treeReducer(EMPTY_TREE_STATE, { type: "load-start", path: DOCS, showHidden: false });
    expect(state.nodes.get(DOCS)?.status).toBe("loading");
    expect(state.nodes.get(DOCS)?.loadedAtMs).toBe(0);

    state = treeReducer(state, {
      type: "load-done",
      path: DOCS,
      entries: [INNER],
      truncated: false,
      showHidden: false,
      atMs: 5_000,
    });
    expect(state.nodes.get(DOCS)?.status).toBe("ready");
    expect(state.nodes.get(DOCS)?.entries).toEqual([INNER]);

    state = treeReducer(state, { type: "load-failed", path: DOCS, error: PERMISSION_DENIED });
    expect(state.nodes.get(DOCS)?.status).toBe("error");
    // The last good listing is kept so a retry does not blank the subtree.
    expect(state.nodes.get(DOCS)?.entries).toEqual([INNER]);
    expect(state.nodes.get(DOCS)?.error).toBe(PERMISSION_DENIED);
  });
});
