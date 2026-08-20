# TREE-SPEC — expand a folder in place (v0.2.0)

Implementation spec for the "VS Code file tree" feature on top of the shipped
`bb-plugin-file-manager`. Written against the code that exists today, not
against an idealised design: every symbol named here is either already in the
repo or is introduced by this document with its exact file, name and signature.

**Relationship to SPEC.md.** SPEC.md stays the LAW and is not edited. This
document is additive and must not contradict it; where it extends a numbered
SPEC.md rule the rule is cited (`§8.2`, `§8.3`, …). `contract.ts` is FROZEN and
this feature does **not** touch it — see §2.1 for the proof.

**One-line summary of the change.** A chevron left of each folder row toggles an
`expanded` set; a pure `flattenTree()` turns the current directory's listing plus
a cache of per-folder child listings into one flat, ordered array of rows that
the existing table renders with a `depth`-derived indent. Everything downstream
of "an ordered list of visible row paths" — selection, ranges, clipboard, drag &
drop, keyboard — keeps working because that list keeps its shape.

---

## 0. What exists today (verified, not assumed)

| Fact | Where |
| --- | --- |
| The table maps a flat `FileEntry[]`: `entries.map((entry) => <FileRow …/>)` | `components/FileTable.tsx:231` |
| No virtualisation anywhere; one `<tr>` per entry, rows are `h-9` | `components/FileTable.tsx`, `components/FileRow.tsx:101` |
| `useSelection(visiblePaths)` is index-based over an ordered `string[]` | `hooks/useSelection.ts:49,88-102,132-155` |
| `useDirectory` owns exactly one listing, sorts/filters client-side | `hooks/useDirectory.ts:212-218` |
| `useDirectory` is consumed **only** by `FileManagerPanel` (Toolbar imports types only) | `grep useDirectory` |
| `sortEntries` / `matchesQuery` are pure and exported | `hooks/useDirectory.ts:46,81` |
| Drop target resolution funnels through one ref: `pendingDropTargetRef` | `components/FileManagerPanel.tsx:203,638,695` |
| `listDir` is one level, never recursive, capped at `MAX_LIST_ENTRIES = 5000` | `src/listing.ts:2`, `contract.ts:28` |
| The `fs` realtime payload is `{ paths: string[], reason }` = *directories that changed* | `contract.ts:156-168`, `src/signals.ts:14-22` |
| Batch RPCs echo back the caller's **source** paths in `succeeded`, never the destination | `src/mutations.ts:5,178,218,227` |
| `useRealtime(channel, handler)` keeps a `Set` of listeners per channel — a second subscription on `"fs"` is legal | `@get-bb/plugin-sdk/dist/testing/app.js:718-735` |
| `ChevronRight` / `ChevronDown` / `Loading` / `AlertTriangle` / `RotateCcw` are all in the vendored `ICON_MAP` | `components/ui/icon.tsx:305-307,367,280` |
| The app SDK exposes no storage hook (`useRpc`, `useRealtime`, `useRealtimeConnectionState`, `useSettings`, `useBbContext`, `useBbNavigate`, `useComposer*` only) | `bundled-types/bb-plugin-sdk-app.d.ts:1620` |

---

## 1. Data model

### 1.1 The three pieces of state

```ts
// lib/fm-tree.ts — new file, pure, no React import.
import type { FileEntry } from "../contract";
import type { ParsedRpcError } from "./errors";

/** One cached directory listing below the current directory. */
export interface TreeNode {
  /** Absolute directory path. This is the cache key. */
  path: string;
  status: "idle" | "loading" | "ready" | "error";
  /** Raw `listDir` output for this directory: unsorted, unfiltered. */
  entries: readonly FileEntry[];
  /** `listDir.truncated` for this node. */
  truncated: boolean;
  /** The `showHidden` the entries were fetched with. */
  showHidden: boolean;
  error: ParsedRpcError | null;
  loadedAtMs: number;
}

export interface TreeState {
  /** Absolute paths of folders the user opened. Insertion-ordered. */
  expanded: ReadonlySet<string>;
  /** path → cached child listing. Only holds nodes below the current dir. */
  nodes: ReadonlyMap<string, TreeNode>;
}
```

* **Node key = the absolute path.** Not `name`, not `depth+index`. Absolute
  paths are what every RPC, the drag payload, the clipboard, the selection set
  and the `fs` signal already speak, so the tree needs no translation layer and
  a node keeps its identity across navigation (expanding `~/docs` while sitting
  in `~`, then navigating into `~/docs`, keeps `~/docs/sub` expanded — the key
  did not change, only the depth at which it renders).
* **`expanded` is a `Set`, not a flag on the node.** Expansion must survive the
  eviction of a cached listing (§7.3) and must be persistable on its own (§6).
* **`entries` are stored raw.** Sorting and filtering are a pure function of
  `(entries, sortField, sortDirection, query)`; caching the sorted form would
  mean invalidating every node when the user clicks a column header, which SPEC
  §8.1 forbids from costing an RPC ("changing the sort column … must never issue
  an RPC" — `hooks/useDirectory.ts:9-10`).
* **Level 0 is *not* in `nodes`.** The current directory keeps being owned by
  `useDirectory`, untouched. `nodes` holds strictly the levels below it. This is
  what makes the change small: `useDirectory`'s stale-response guard, realtime
  handling, error banner and skeletons keep working exactly as today, and the
  tree is a layer on top.

### 1.2 The rendered row

```ts
export type TreeRow =
  | {
      kind: "entry";
      /** React key and DOM id: the absolute path. */
      key: string;
      entry: FileEntry;
      /** 0 for a child of the current directory. */
      depth: number;
      /** Absolute path of the directory this row was listed from. */
      parentPath: string;
      /** True for a navigable directory below MAX_TREE_DEPTH. */
      expandable: boolean;
      expanded: boolean;
      /** Its child listing is in flight. */
      loading: boolean;
    }
  | {
      kind: "status";
      key: string;
      depth: number;
      parentPath: string;
      status: "empty" | "error";
      /** Human text for the error row; null for "empty". */
      message: string | null;
    };
```

`status` rows exist so an expanded folder is never a silent no-op: an empty
folder says so, a failed listing shows the message and a Retry (§2.3). A
*loading* level renders no status row at all — the spinner replaces the chevron
on the parent row, which is both cheaper and what VS Code does.

### 1.3 Where the state lives, and why

**`hooks/useTree.ts` (new), mounted once inside `FileManagerPanel`, directly
after `useDirectory`.**

Rejected alternatives, with the reason:

* *Inside `useDirectory`* — `useDirectory` is a single-listing hook with a
  single-ticket stale-response guard (`requestId`, `hooks/useDirectory.ts:135`).
  Making it multi-path means rewriting that guard per key, and it is the one
  file whose behaviour 5 existing suites lean on. Leave it alone.
* *Inside `FileTable`* — the table is presentational and must stay so; the
  panel is already "the single source of truth for selection, clipboard and drag
  state" (`components/FileRow.tsx:4-6`), and expansion has to compose with all
  three.
* *In the URL `subPath`* — SPEC §8 is explicit: "Sort, search, hidden-toggle and
  selection live in React state, **never** in the URL". The expanded set is the
  same class of state and a path containing `?`/`#` would break the round trip.
* *In a React context* — the header/sidebar slots are mounted in a different
  React subtree (`components/panel-bus.ts:4-8`); nothing outside the panel body
  needs the expanded set, so no context and no `panel-bus` change is required.

`useTree` owns: the reducer state above, the `listDir` fan-out with its
concurrency cap, the `fs` invalidation, the persistence write-back, and the
flatten memo. It returns rows, not raw state, so the loader effect can key off
what is actually *visible* (§7.2).

```ts
// hooks/useTree.ts
export interface UseTreeArgs {
  /** Current directory = the flatten root. */
  rootPath: string;
  /** Level-0 rows, already sorted by useDirectory (query NOT applied). */
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
  /** Paths of the `kind: "entry"` rows, in render order. Feeds useSelection. */
  visiblePaths: string[];
  /** True when flatten hit MAX_TREE_ROWS. */
  rowsTruncated: boolean;
  expandedCount: number;
  isExpanded: (path: string) => boolean;
  toggle: (entry: FileEntry) => void;
  expand: (path: string) => void;
  collapse: (path: string) => void;
  collapseAll: () => void;
  /** Retry one failed node. */
  reload: (path: string) => void;
  /** Manual refresh: mark every cached node stale. */
  refreshAll: () => void;
  /** Delete/move: drop these paths and everything below them. */
  pruneSubtree: (paths: readonly string[]) => void;
  /** Rename: re-key the subtree from `from` to `to`. */
  remapPrefix: (from: string, to: string) => void;
}

/** Test seam, mirroring resetPanelSnapshot / resetUploadManager. */
export function resetTreeStore(): void;
```

### 1.4 The reducer is pure and lives in `lib/fm-tree.ts`

```ts
export type TreeAction =
  | { type: "hydrate"; expanded: readonly string[] }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "collapse-all" }
  | { type: "load-start"; path: string; showHidden: boolean }
  | { type: "load-done"; path: string; entries: readonly FileEntry[];
      truncated: boolean; showHidden: boolean; atMs: number }
  | { type: "load-failed"; path: string; error: ParsedRpcError }
  | { type: "invalidate"; paths: readonly string[] }
  | { type: "invalidate-all" }
  | { type: "prune"; paths: readonly string[] }
  | { type: "remap"; from: string; to: string }
  | { type: "set-root"; path: string };

export function treeReducer(state: TreeState, action: TreeAction): TreeState;
export const EMPTY_TREE_STATE: TreeState;
```

Every non-trivial transition (prune a subtree, remap a rename, evict past the
cap, invalidate on a signal) is therefore unit-testable with no DOM and no RPC —
that is the whole reason the reducer is a pure export instead of six `useState`s.

Invariants the reducer enforces:

* `expand` on a path already in `expanded` is a no-op (identity-stable state).
* `expand` evicts from the **front** of `expanded` while `size > MAX_EXPANDED_PATHS`,
  skipping any path that is an ancestor of the newly expanded one
  (`isDescendant(newPath, candidate)` from `lib/fm-paths.ts:146`).
* `collapse(p)` removes `p` from `expanded` **but keeps `p`'s descendants in
  `expanded`** — VS Code semantics: re-expanding restores the shape you left.
* `prune`/`remap` use `isSameOrDescendant` (`lib/fm-paths.ts:154`) so a sibling
  with a shared prefix (`/a/docs2` vs `/a/docs`) is never touched — the existing
  `fm-paths` test "does not treat a sibling with a shared prefix as a descendant"
  already pins that helper.
* `invalidate` sets `status: "idle"` and **keeps** `entries`, so a signalled
  refetch re-renders without flicker (same policy as `useDirectory`'s background
  refetch, `hooks/useDirectory.ts:157`).
* `set-root` (the user navigated) drops every node that is neither an ancestor
  nor a descendant of the new root, then applies the `MAX_CACHED_NODES` cap by
  dropping the least-recently-loaded **collapsed** nodes first.

### 1.5 Constants (all in `lib/fm-tree.ts`)

```ts
export const INDENT_STEP_PX = 12;      // per depth level
export const MAX_INDENT_DEPTH = 12;    // visual clamp: indent stops growing
export const MAX_TREE_DEPTH = 32;      // rows deeper than this get no chevron
export const MAX_TREE_ROWS = MAX_LIST_ENTRIES;   // 5000, imported from contract.ts
export const MAX_EXPANDED_PATHS = 200;
export const MAX_CACHED_NODES = 256;
export const LOAD_CONCURRENCY = 4;
export const AUTO_EXPAND_HOVER_MS = 700;
export const EXPANDED_STORAGE_KEY = "bb-plugin-file-manager:expanded:v1";
export const EXPANDED_STORAGE_MAX_BYTES = 64 * 1024;
```

---

## 2. Lazy loading

### 2.1 No contract change is needed — explicitly

**Verified against the frozen `contract.ts`. The tree adds zero RPC methods,
zero fields and zero schema edits.**

* `listDir` (`contract.ts:198-219`) already takes `{ path, showHidden }` and
  returns exactly one level: `{ path, parentPath, isRoot, entries, truncated,
  totalEntries, hiddenCount, writable, volume }`. Expanding `~/docs` is
  `rpc.call("listDir", { path: "/home/coder/docs", showHidden })` — the same call
  the panel already makes when you *navigate* into `~/docs`, and the same call
  `FolderPickerDialog` already makes to browse. Nothing about it is
  directory-of-the-panel specific.
* `entrySchema` (`contract.ts:90-108`) already carries everything a chevron
  decision needs: `kind`, `targetKind`, `isSymlink`, `escapesRoot`. The
  existing `isDirectoryEntry()` (`components/FileRow.tsx:22`) is the predicate,
  unchanged.
* The `fs` channel (`contract.ts:156-168`) already publishes *changed
  directories*, which is precisely the cache key of `TreeNode`. Nothing new to
  publish.
* `writable` and `volume` are per-directory in the response and are only read
  for the **current** directory (`FileManagerPanel.tsx:269,977`). Child nodes
  return them too; the tree ignores them (see §5.9 for the consequence).
* The one thing that *would* have needed a contract change — persisting the
  expanded set server-side — is deliberately not done: `savePreferences`
  (`contract.ts:370-384`) is a `z.strictObject` with six fixed optional keys and
  `src/settings.ts:19-56` declares six matching descriptors; there is no free-form
  key and the descriptor types are `string | boolean | select` only. Persistence
  is therefore client-side (§6), which is also the correct layer for view state.

**Consequence for the build:** `server.ts`, everything under `src/`, everything
under `test/backend/` and `test/integration/plugin-factory.test.ts` are
untouched. That integration test must keep asserting 17 rpc methods, 2 http
routes and 1 cron schedule, and must keep passing without edits.

### 2.2 The load loop

An effect inside `useTree`, driven by the flattened `rows` (not by `expanded`):

1. Collect candidates: `rows` where `kind === "entry" && expanded === true` and
   the node is missing, `status === "idle"`, or `node.showHidden !== showHidden`.
2. Subtract the in-flight set (`useRef<Set<string>>`).
3. Start up to `LOAD_CONCURRENCY - inFlight.size` of them, oldest-shallowest
   first (`rows` order is already depth-major).
4. Each call: `dispatch({ type: "load-start" })` → `rpc.call("listDir", { path,
   showHidden })` → `load-done` / `load-failed`, then delete from the in-flight
   set. Guard on a per-path ticket ref so a `showHidden` flip mid-flight cannot
   commit a stale listing (same pattern as `hooks/useDirectory.ts:146-151`, but
   keyed by path).
5. Completing a load changes `rows`, so the effect re-runs and starts the next
   batch. This makes restore breadth-first *for free*: a depth-3 expanded path is
   not even a candidate until its depth-2 parent has loaded and rendered it.

That property is what removes the need for a separate "restore budget": with
`MAX_EXPANDED_PATHS = 200` and `LOAD_CONCURRENCY = 4`, a cold panel with a fully
saturated expanded set issues at most 200 `listDir` calls, four at a time, level
by level, and only for nodes that are actually on screen after their ancestors
resolved. Nodes whose ancestors are collapsed cost nothing.

`enabled: false` (bootstrap not finished, `FileManagerPanel.tsx:251`) suspends
the loop entirely.

### 2.3 Errors

`load-failed` stores the `ParsedRpcError` (`lib/errors.ts#parseRpcError`, already
used everywhere). The flatten then emits a `status: "error"` row directly under
the folder, at `depth + 1`:

```
▾ 📁 secrets
    ⚠ permission_denied — EACCES … [Retry]
```

* Rendered by a new `TreeStatusRow` in `components/FileTable.tsx`, spanning
  `colSpan={4}`, `h-9`, `text-xs text-muted-foreground`, icon `AlertTriangle`
  `size-3.5 text-destructive`, indented by the same `depth * INDENT_STEP_PX`.
* Retry button: `variant="ghost" size="sm"`, `data-testid="fm-tree-retry"`,
  accessible name **`Retry loading <folder name>`** — deliberately *not* the bare
  "Retry" of `ErrorBanner`, so `panel.test.tsx:206`'s
  `getByRole("button", { name: "Retry" })` stays unambiguous.
* Retry calls `tree.reload(path)` → `invalidate` → the loop picks it up.
* A failed node never blocks anything else; the rest of the tree keeps loading.
* `escapesRoot` folders are never expandable (§3.2), so `path_escape` cannot
  reach this row from a chevron click.

### 2.4 Cache invalidation from the backend's realtime signal

`useTree` takes its **own** `useRealtime(FS_CHANNEL, …)` subscription (legal —
the runtime keeps a `Set` of handlers per channel, verified in
`plugin-sdk/dist/testing/app.js:718-735`; `useDirectory` and `useJobs` already
subscribe to two different channels from the same tree).

```ts
useRealtime(FS_CHANNEL, useCallback((payload: unknown) => {
  const paths = (payload as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths)) return;                    // same guard as useDirectory
  const hits = paths.filter(
    (p): p is string => typeof p === "string" && nodesRef.current.has(normalizePath(p)),
  );
  if (hits.length > 0) dispatchRef.current({ type: "invalidate", paths: hits });
}, []));
```

Rules:

* **Only paths already in `nodes` are invalidated.** A signal for a directory the
  tree never listed is ignored. This is what keeps
  `panel.test.tsx:317` ("an `fs` signal for `${ROOT}/elsewhere` must not cause a
  second `listDir`") green.
* An invalidated node that is still expanded and visible is refetched by the
  load loop (one `listDir`); an invalidated node that is collapsed is simply
  refetched later, when re-expanded.
* The **current directory** is not in `nodes`; `useDirectory` refetches it
  exactly as today. No double fetch, no coordination needed.
* Reconnect: `useTree` mirrors `useDirectory`'s §7.3 rule with its own
  `useRealtimeConnectionState()` watcher — a transition *into* `"connected"`
  dispatches `invalidate-all`, because signals published while the socket was
  down are gone.
* Manual **Refresh** (toolbar button, `refresh` panel command) calls
  `tree.refreshAll()` next to `refetchRef.current()`.

---

## 3. Row rendering

### 3.1 Where the indent goes

The four columns stay exactly as they are — checkbox `w-8 pl-3 pr-0`, name
`min-w-0`, size `hidden w-24 @md:table-cell`, modified `hidden w-32
@md:table-cell`. **Indentation happens strictly inside the name cell**, like VS
Code's twistie, so:

* the checkbox gutter stays a straight vertical line at every depth (a nested
  checkbox marching right would be unreadable and would break the
  select-all/indeterminate affordance);
* the right-hand `size` / `modified` columns stay aligned, which is the entire
  point of keeping a `<table>`;
* nothing in the `@md` container-query layout changes.

```tsx
// components/FileRow.tsx — the name cell, after the change
const indentPx = Math.min(depth, MAX_INDENT_DEPTH) * INDENT_STEP_PX;

<TableCell className="min-w-0 py-0">
  <div
    className="flex min-w-0 items-center gap-2"
    style={{ paddingInlineStart: indentPx }}
  >
    {chevronSlot}
    <Icon name={entryIconName(entry)} className={cn("size-4 shrink-0", …)} aria-hidden="true" />
    <span className="truncate">{entry.name}</span>
    {symlinkBadge}
  </div>
</TableCell>
```

`paddingInlineStart` on the existing flex container — not a spacer element and
not a per-depth Tailwind class (Tailwind cannot generate 33 arbitrary classes
from a runtime number, and the plugin stylesheet is `@scope`d and pre-built,
SPEC §9). Inline `style` for a *geometry* value is allowed; inline `style` for a
*colour* is what §9 forbids. `truncate` keeps working because the flex child is
still `min-w-0` inside a `min-w-0` cell.

### 3.2 The chevron

```tsx
const chevronSlot = expandable ? (
  <button
    type="button"
    tabIndex={-1}
    data-testid="fm-chevron"
    data-fm-chevron={entry.path}
    aria-expanded={expanded}
    aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`}
    className={cn(
      "flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground",
      "hover:bg-state-hover hover:text-foreground",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      "max-md:pointer-coarse:size-5",            // coarse-pointer hit target, §9 convention
      CONTROL_HOVER_TRANSITION,
    )}
    onMouseDown={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      onToggleExpand(entry);
    }}
  >
    <Icon
      name={loading ? "Loading" : "ChevronRight"}
      className={cn(
        "size-3.5 transition-transform duration-150",
        loading && "animate-spin",
        !loading && expanded && "rotate-90",
      )}
      aria-hidden="true"
    />
  </button>
) : (
  <span className="size-4 shrink-0 max-md:pointer-coarse:size-5" aria-hidden="true" />
);
```

* **One glyph, rotated.** `ChevronRight` at `rotate-90` for expanded, with
  `transition-transform duration-150` — matches the house timing language
  (`components/ui/motion.ts`). `ChevronDown` exists but swapping glyphs cannot
  animate.
* **Files get a 16px placeholder**, never `display: none`, so names line up in a
  mixed folder — the single most visible difference between a real tree and a
  fake one.
* `expandable` = `isDirectoryEntry(entry) && depth < MAX_TREE_DEPTH`.
  `isDirectoryEntry` (`components/FileRow.tsx:22`) already excludes
  `escapesRoot` and resolves a symlink to its `targetKind`, so a symlink to a
  directory inside the root **is** expandable (consistent with double-click
  navigating into it) and a link leaving the root is not.
* `tabIndex={-1}`: the panel root owns keyboard focus (§8.3); the row checkbox
  already does the same (`FileRow.tsx:127`).
* `stopPropagation` on `click` **and** `mousedown` **and** `dblclick`: a
  chevron click must not select the row, must not start the row's drag, and a
  fast double-toggle must not navigate into the folder.
* Hover affordance: the chevron picks up `hover:bg-state-hover` on itself, and
  the row's own `hover:bg-state-hover` still fires because the button is a
  descendant. No extra "reveal on hover" — a chevron that only appears on hover
  is unusable with a trackpad on a 36px row and invisible on touch.

### 3.3 Indent guides

**Not shipped in v1, and the reason is written down so nobody re-litigates it:**
guides need one absolutely-positioned 1px element per depth per row (36 extra
DOM nodes at depth 6 × 200 rows), and the only §9-legal way to paint them is
`border-l border-border-hairline` on real elements — arbitrary colours are
forbidden. If they are added later the shape is:

```tsx
{Array.from({ length: Math.min(depth, MAX_INDENT_DEPTH) }, (_u, i) => (
  <span key={i} aria-hidden="true"
        className="-my-px h-9 w-3 shrink-0 border-l border-border-hairline" />
))}
```
rendered *instead of* `paddingInlineStart`, inside the same flex container.

### 3.4 Row identity, ARIA and test hooks

* `<table role="treegrid">` replaces `role="grid"` (`FileTable.tsx:131`). No
  existing test queries that role (checked); `aria-label="Files"` stays.
* Each entry `<tr>` gains `aria-level={depth + 1}`,
  `aria-expanded={expandable ? expanded : undefined}` and
  `data-fm-depth={String(depth)}`. `data-fm-path` stays the primary hook — it is
  what `focusRow` (`FileManagerPanel.tsx:741`), `handleBackgroundClick`
  (`:575`) and four test suites use, and it keeps working unchanged because
  nested rows carry it too.
* `key` stays `entry.path` — unique across the whole flattened tree by
  construction.
* Status rows: `data-testid="fm-tree-error"` / `"fm-tree-empty"`,
  `data-fm-parent-path={parentPath}`, and **no** `data-fm-path` (so they are
  invisible to selection, to `handleBackgroundClick`'s row check and to
  `focusRow`).

### 3.5 Skeletons, `..`, empty state

* The `..` row (`FileTable.tsx:179-206`) is untouched: always first, never
  indented, no chevron, still a drop target. It is navigation, not tree content.
* Skeleton rows (`:208-230`) are untouched — they only render when
  `loading && rows.length === 0`, i.e. level 0 is cold.
* `emptyState` renders when `!loading && rows.length === 0`, now counted over
  flattened rows.

---

## 4. Interactions

### 4.1 Mouse

| Action | Result | Change? |
| --- | --- | --- |
| click the chevron | toggle expansion; selection and anchor untouched; keyboard focus moves to that row (`selection.setFocus(path)`) | new |
| click the row | select only that row (§8.2) | unchanged |
| `Ctrl/Cmd` + click | toggle that row | unchanged |
| `Shift` + click | inclusive range **over the flattened order** | §5.2 |
| click the checkbox cell | toggle without clearing others | unchanged |
| double click a folder row | navigate into it (`toPluginPanel`) | unchanged — deliberately *not* "expand" |
| double click a folder row's chevron | toggles twice, does not navigate | new (`stopPropagation`) |
| right click a nested row | `RowContextMenu` on the (possibly cross-directory) selection | §5.3 |
| click empty table space | clear selection | unchanged |

The double-click-navigates rule is kept because it is the muscle memory this
panel already trained, and because the tree is an *additional* way to look
inside, not a replacement for `cd`.

### 4.2 Keyboard (extends §8.3)

Added to the `switch (event.key)` in `handleKeyDown`
(`FileManagerPanel.tsx:800`), with `mod`/`isTypingTarget` guards unchanged:

| Key | On | Action |
| --- | --- | --- |
| `→` | collapsed expandable row | expand it |
| `→` | expanded row | move focus to its first child row (`selection.moveFocus(1)`) |
| `→` | file row / non-expandable | nothing, and **no `preventDefault`** (§8.3) |
| `←` | expanded row | collapse it |
| `←` | collapsed or file row at `depth > 0` | move focus to the parent row (`selection.select(parentPath)`) |
| `←` | row at `depth === 0` | nothing |
| `Alt+←` | anywhere | go to parent directory — **checked first, unchanged** |
| `Enter` | any row | `openEntry` — folder navigates in, file downloads, archive opens the dialog — unchanged |
| `↑ ↓ Home End` | — | move over the flattened order, unchanged code |

Implementation note: the `ArrowLeft` case already exists and returns unless
`event.altKey` (`:827-832`); the new behaviour goes in that same case *after*
the alt branch, so `keyboard.test.tsx:207` ("goes to the parent with Backspace
and with Alt+ArrowLeft") is unaffected. `ArrowRight` is a brand new case; today
the `default` branch swallows it without `preventDefault`, and it must keep
doing so for non-expandable rows.

`Shift+→` / `Shift+←` are **not** bound (no VS Code equivalent worth the
ambiguity with range selection).

### 4.3 Expand-all / collapse-all

* **Collapse all — shipped.** It is `dispatch({ type: "collapse-all" })`: one
  reducer action, no I/O. Surfaced twice:
  * a `Toolbar` ghost icon button between the hidden-files toggle and Refresh,
    `data-testid="fm-collapse-all"`, `aria-label="Collapse all folders"`, icon
    `Minimize2`, **always rendered** and `disabled={expandedCount === 0}` (a
    button that appears and disappears would shift the toolbar);
  * a `BackgroundContextMenu` item "Collapse all folders", same disabled rule.
* **Expand all — not shipped.** It is N `listDir` calls over an unknown fan-out;
  on `/home/coder` that is unbounded work for a gesture with no undo. The
  cheap, honest subset — `Alt`+click a chevron to expand every **already cached**
  descendant — is listed in §10 as a follow-up, not built now.
* No new global keyboard shortcut for either (the host owns `Ctrl/Cmd+Shift+*`
  combos the panel has not claimed; SPEC §8.3 warns against grabbing keys).

---

## 5. Interaction with everything already built

### 5.1 Multi-select across depths

`useSelection` is fed `tree.visiblePaths` instead of `directory.visiblePaths`
(`FileManagerPanel.tsx:253`). One line. Everything else falls out:

* Selecting `~/a.txt` and `~/docs/inner.txt` at once is now possible. Every
  batch RPC takes absolute paths (`contract.ts:264,272,281`), so `deleteEntries`,
  `moveEntries`, `copyEntries` and the download route already handle a
  cross-directory selection with no change.
* `Ctrl/Cmd+A` now selects every **visible** row including expanded children.
  That is the documented meaning ("select all visible rows", §8.3) and the
  `ConfirmDeleteDialog` lists what will go, but it is a real behaviour change
  and must be called out in the README changelog.
* The header select-all checkbox and its indeterminate state are computed over
  the same flattened rows (`FileTable.tsx:122-128` counts entry rows only).
* **Collapsing prunes.** `useSelection`'s existing effect
  (`hooks/useSelection.ts:56-71`) drops selected paths that left `visiblePaths`,
  so collapsing a folder deselects its hidden children instead of leaving a
  ghost selection that a later `Delete` would act on. This is the correct and
  safe default, and it is already implemented — do not "fix" it.

### 5.2 Shift-range over the flattened tree

`extendTo` / `moveFocus` index into `pathsRef.current`
(`hooks/useSelection.ts:88-102,132-155`). Because `visiblePaths` is the flattened
render order, a Shift-range from a row above an expanded folder to a row below
it selects the folder *and* its visible children — exactly VS Code, exactly
Finder, and with zero code change in `useSelection`.

### 5.3 Cut / copy / paste

* `clipboard.cut/copy(selection.selectedPaths)` — absolute paths from mixed
  depths, fine as-is.
* Cut rows at any depth render at `opacity-50`: `cutPaths` is a `Set<string>` of
  absolute paths matched per row (`FileTable.tsx:238`), depth-agnostic.
* **Paste destination stays the current directory**, not the focused folder
  row. `paste()` reads `currentPathRef.current` (`:457`) and `canPasteInto`
  drives the menu item; changing that to "paste into the highlighted folder"
  would silently reinterpret every existing `Ctrl+V` in a tree the user may have
  expanded by accident. Explicitly unchanged; §10 lists "Paste into folder" as a
  separate, opt-in context-menu item for later.
* `canPasteInto` already refuses a destination inside a cut source
  (`hooks/useClipboard.ts:62-71`) — unchanged and still correct, since the tree
  changes what is *visible*, not what is *current*.
* After a successful paste the panel calls `tree.pruneSubtree(movedPaths)` for a
  cut (the sources are gone) — see §5.4.

### 5.4 Delete, rename and move of an expanded folder

Three distinct cases, and they are not symmetric:

* **Delete** — in `applyBatch(result, "delete")` (`:364`): call
  `tree.pruneSubtree(result.succeeded)`. `succeeded` echoes the caller's own
  source paths (`src/mutations.ts:5,178`), which is exactly what the tree keys
  on. Prune removes the node, its cached descendants and their `expanded`
  entries.
* **Move (drag, Move to…, cut+paste)** — also `tree.pruneSubtree(result.succeeded)`,
  i.e. the moved subtree **collapses**. Remapping is impossible here and the
  reason is concrete: `moveEntries` returns the *source* paths in `succeeded`,
  and with `conflict: "rename"` the destination base name may have been
  suffixed, so the panel cannot know the new absolute path. Collapsing is
  correct-by-construction; a wrong remap would leave a node keyed to a path that
  does not exist and would fail its next refetch with `not_found`.
* **Rename** — `renameEntry` returns `{ entry }` with the new absolute path
  (`contract.ts:254-260`), so the panel calls
  `tree.remapPrefix(oldPath, result.entry.path)` in the `RenameDialog.onSubmit`
  handler (`:1189-1192`). The subtree keeps its expansion and its caches under
  the new key. This is the one case where remap is safe, so it is the one case
  where it is done.
* **A rename dialog opened on a nested row must validate against the right
  siblings.** Today `existingNames` is built from `directory.data.entries`
  (`:275-278`) — the *current* directory. For a nested row that set is wrong (it
  would let a colliding name through to the backend, which then returns
  `exists`). Fix: a new memo

  ```ts
  const siblingNames = useCallback((path: string): ReadonlySet<string> => {
    const parent = dirname(path);
    if (isSamePath(parent, currentPath)) return existingNames;
    return new Set((tree.nodeEntries(parent) ?? []).map((e) => e.name));
  }, [currentPath, existingNames, tree]);
  ```

  passed to `RenameDialog` as `existingNames={siblingNames(dialog.entry.path)}`.
  `NewFolderDialog` keeps `existingNames` (it always creates in the current
  directory). `useTree` therefore also exports
  `nodeEntries(path): readonly FileEntry[] | null`.

### 5.5 Drag & drop

* **Row as a drag source** — unchanged. `handleRowDragStart` (`:615`) puts
  `selection.selectedPaths` on the transfer; those are absolute and may now span
  depths, which the backend already handles.
* **Row as a drop target — one deliberate improvement.** `dropTargetFor`
  (`:606-613`) becomes depth-aware:

  ```ts
  const dropTargetFor = useCallback((row: TreeEntryRow): string | null => {
    const { entry, depth, parentPath } = row;
    if (entry.escapesRoot) return null;
    if (effectiveKind(entry) === "directory") return entry.path;
    // A file row inside an expanded folder resolves to that folder, not to the
    // current directory — otherwise a drop on `docs/inner.txt` would land in `~`.
    return depth > 0 ? parentPath : null;
  }, []);
  ```

  At `depth === 0` the behaviour is byte-for-byte what it is today (`null` →
  `handleRootDrop` falls back to `currentPathRef.current`), so
  `dragdrop.test.tsx` and `uploads.test.tsx` do not move.
* **Drop onto a collapsed folder** — allowed, same as today; the folder is
  invalidated by the resulting `fs` signal and shows the new content when
  expanded.
* **Drop onto an expanded folder** — allowed; the `fs` signal names that
  directory, it is in `nodes`, so it refetches and the new child appears in
  place without a navigation.
* **Drop onto a nested folder** — allowed, no special case: `dropTargetFor`
  returns the nested absolute path and `pendingDropTargetRef` carries it into
  `handleRootDrop` (`:695-697`) for both the internal (`moveEntries`) and the
  external (upload `dirPath`) branch.
* **Auto-expand on hover** — new, in `FileManagerPanel`:

  ```ts
  const hoverExpandRef = useRef<{ path: string; timer: number } | null>(null);
  ```

  `handleRowDragOver` schedules `window.setTimeout(() => tree.expand(path),
  AUTO_EXPAND_HOVER_MS)` the first time a given collapsed, expandable row is
  hovered during a drag; any change of hovered path, `dragleave`, `drop`,
  `dragend` or unmount clears it. Never auto-**collapses** (a folder that opened
  under the pointer and then shut would be maddening). Never fires for a row
  that is part of the drag payload (`selection.isSelected(path)` — the same
  guard `handleRowDragOver` already applies at `:637`).
* **Invalid targets still reject**: self, a row inside the current drag
  selection, and `escapesRoot` — all three guards already live in
  `handleRowDragOver` and are unchanged. Moving a folder *into its own expanded
  descendant* is rejected server-side (`destination_inside_source`) and
  client-side by `isSameOrDescendant`; add the same check to `dropTargetFor`'s
  caller so the row does not even highlight:
  `paths.some((p) => isSameOrDescendant(target, p))` → no highlight, no drop.

### 5.6 Upload drop target resolution for a nested row

Falls out of §5.5: `handleRootDrop` (`:692`) computes
`destination = pending ?? dropTarget ?? currentPathRef.current` and passes it as
`dirPath` to every `UploadRequest` (`:708,717`). With the depth-aware
`dropTargetFor`, dropping an OS folder onto `docs/` (collapsed or expanded, at
any depth) uploads into `docs/`, and the `relativeDir` walk is untouched. The
`fs` upload signal then refreshes whichever node it landed in.

### 5.7 Search / filter

The toolbar filter is client-side over already-fetched entries
(`hooks/useDirectory.ts:214`). In a tree that has to mean something precise:

**Rule (normative).** `flattenTree` applies `matchesQuery` to every level it
walks, and keeps a folder row that does not match itself **iff** it is expanded
and at least one row inside it survived the filter. Ancestors of a match are
never hidden. Collapsed folders are matched by their own name only.

```
build(dir, entries, depth) -> { rows, matched }
  for entry of sorted(entries):
    selfMatch = matchesQuery(entry, query)
    child = expanded(entry) ? build(entry.path, node.entries, depth+1)
                            : { rows: [], matched: false }
    if (!selfMatch && !child.matched) continue
    push(entryRow); push(...child.rows)
    matched ||= true
```

With `query === ""` `matchesQuery` returns `true` for everything, so this is one
code path, not two.

**Honesty caveat, to be written in the UI copy, not just here:** the filter never
fetches. Matches inside *collapsed* folders are not found, because their listings
were never requested. That is a filter, not a search. The contract already has
the right tool for the other job — `searchDir` (`contract.ts:230-243`,
depth-limited, `MAX_SEARCH_RESULTS`) — and wiring it up is §10, not this feature.
The existing `EmptyState kind="no-results"` copy ("Nothing in this folder matches
your filter") is already scoped correctly.

`useDirectory` is **no longer given `query`** by the panel; the filter moves
wholesale into `flattenTree` so there is exactly one implementation of it. The
panel keeps passing `sortField`/`sortDirection`, and `directory.entries` (sorted,
unfiltered) becomes the level-0 input to the tree.

### 5.8 Sorting within each parent

`flattenTree` calls the existing `sortEntries(entries, sortField, sortDirection,
{ foldersFirst: true })` per level. Level 0 is already sorted by `useDirectory`
with identical arguments, so the flatten uses it as-is (no double sort). Sorting
is therefore per-parent, folders-first within each parent — the VS Code
behaviour, and the only one that makes sense when a child listing is a different
directory than its siblings. Changing the sort column re-runs the memo and
issues **no** RPC, preserving the guarantee in `hooks/useDirectory.ts:9-10`.

### 5.9 The `..` row, the hidden-file toggle, `writable`, truncation

* `..` — unchanged (§3.5).
* **Hidden files** — every node listing must agree with the current toggle.
  `TreeNode.showHidden` records what a node was fetched with; the load loop
  treats a mismatch as stale (§2.2 step 1), so flipping the toggle refetches the
  expanded nodes and drops the collapsed ones on their next expand. No extra
  action type needed. Hidden **rows** are never filtered client-side: the server
  does it (`listDir` + `hiddenCount`), and the tree keeps that property.
* **`writable`** is read only for the current directory
  (`FileManagerPanel.tsx:269`). A nested row inside a read-only folder therefore
  still shows enabled write actions, and the backend rejects the operation with
  `permission_denied` → toast. Accepted for v1 and written down here so it is a
  known limitation rather than a bug report; the fix (per-node `writable` from
  the cached listing feeding `RowContextMenu`) is §10.
* **Truncation** — a child node with `truncated: true` renders a
  `kind: "status"` row… no: it reuses the **error-row chrome with a warning
  tone** — `status: "empty"` is for empty, so add nothing new; instead the
  folder row gets `title={`${name} — showing the first ${MAX_LIST_ENTRIES} of
  ${totalEntries}`}`. A whole banner per nested node would be noise. The
  top-level truncation banner (`:1004-1009`) is unchanged.

---

## 6. Persistence of the expanded set

**Requirement:** survive (a) navigating between directories, (b) a remount of
the panel component, (c) a bb/app restart. **Not** required to survive a plugin
uninstall or to sync across machines.

**Mechanism — two tiers, in `hooks/useTree.ts` module scope:**

```ts
let sessionExpanded: string[] | null = null;   // tier 1: page session

function readExpanded(): string[] {            // tier 2: localStorage
  if (sessionExpanded !== null) return sessionExpanded;
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    const paths = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
    sessionExpanded = paths.filter((p) => isInsideRoot(p)).slice(-MAX_EXPANDED_PATHS);
  } catch {
    sessionExpanded = [];                      // storage denied / corrupt JSON
  }
  return sessionExpanded;
}

function writeExpanded(paths: readonly string[]): void {
  sessionExpanded = [...paths];
  const json = JSON.stringify(sessionExpanded);
  if (json.length > EXPANDED_STORAGE_MAX_BYTES) return;   // never blow the quota
  try { window.localStorage.setItem(EXPANDED_STORAGE_KEY, json); } catch { /* ignore */ }
}

/** Test seam. */
export function resetTreeStore(): void { sessionExpanded = null; }
```

* Tier 1 (module-level `sessionExpanded`) covers (a) and (b) — navigation
  remounts nothing today, but a route change or a panel close/open must not lose
  the tree, and it also makes the feature work when `localStorage` throws
  (Electron partition, storage denied). It is the same pattern the codebase
  already uses for cross-mount state (`components/panel-bus.ts`,
  `hooks/useUploads.ts#resetUploadManager`), including the exported reset.
* Tier 2 covers (c). Key is namespaced with the plugin id and a `v1` suffix so a
  future shape change is a key change, not a migration.
* Writes are **debounced 250 ms** in a `useEffect` on `expanded`, so a fast
  expand/collapse burst is one write.
* Every `localStorage` access is inside `try/catch`. A failure degrades to
  tier 1 only — never a throw, because a throw inside a slot component kills the
  plugin's UI for the whole session (§8.1).
* **Cap: `MAX_EXPANDED_PATHS = 200`**, enforced in the reducer on `expand`
  (front-eviction, skipping ancestors of the new path — §1.4) and again on
  hydrate (`slice(-MAX_EXPANDED_PATHS)`). A second, independent guard caps the
  serialized payload at 64 KB. 200 open folders is already an unusable screen;
  the cap exists to bound memory and the storage row, not to be reached.
* Hydrate runs once, in a `useState` initialiser →
  `dispatch({ type: "hydrate", expanded: readExpanded() })`, i.e. before the
  first paint, so there is no visible collapse-then-expand flash.
* Paths outside `ROOT_PATH` are dropped on hydrate (`isInsideRoot`,
  `lib/fm-paths.ts:72`) — cheap defence against a hand-edited storage row.
* Nothing is persisted server-side: `savePreferences` cannot carry it (§2.1) and
  view state does not belong in plugin settings anyway.

---

## 7. Performance

### 7.1 It does not virtualise today, and this feature does not add virtualisation

`FileTable` renders `entries.map(...)` into a real `<tbody>`
(`FileTable.tsx:231`). At `MAX_LIST_ENTRIES = 5000` that is already 5000 `<tr>`
today, and it is acceptable because the backend caps the listing. The tree can
multiply that, so it gets **three concrete caps instead of a virtualiser**:

1. **`MAX_TREE_ROWS = MAX_LIST_ENTRIES` (5000) — hard cap on flattened rows.**
   `flattenTree` stops appending at the cap and returns `truncated: true`. The
   panel then renders a one-line warning strip in the same style as the existing
   truncation banner (`:1004-1009`):
   *"Showing the first 5000 rows. Collapse a folder to see more."*
   Depth-first order means the cap always eats the *bottom* of the list, never a
   random middle.
2. **`MAX_EXPANDED_PATHS = 200`** — bounds the number of nodes that can be
   simultaneously live, and therefore the memory held in `nodes`.
3. **`MAX_CACHED_NODES = 256`** with LRU eviction of collapsed nodes only
   (§1.4 `set-root`), so walking around a big tree cannot grow the cache without
   bound. 256 × up to 5000 entries is the theoretical worst case, but in practice
   only expanded nodes are large and those are capped at 200 by (2).

### 7.2 A 100k-entry folder

The backend already truncates: `listDir` returns at most 5000 entries with
`truncated: true` (`src/listing.ts`, `contract.ts:28`). So expanding a
100k-entry folder costs one `readdir`+`lstat` pass server-side (unchanged from
navigating into it today) and 5000 rows client-side, and the folder row carries
the truncation tooltip from §5.9. No new backend risk.

### 7.3 Deep nesting

`MAX_TREE_DEPTH = 32` removes the chevron beyond depth 32, which makes the
recursion in `flattenTree` provably bounded (and a symlink cycle inside the root
cannot loop forever — the depth cap catches it even though `listDir` does not
resolve links, `src/listing.ts:2-3`). `MAX_INDENT_DEPTH = 12` clamps the visual
indent at 144 px so a deep row still shows its name in a narrow panel.

### 7.4 Many expanded nodes at once

* Loads are capped at `LOAD_CONCURRENCY = 4` in flight, level by level (§2.2), so
  a cold restore of 200 expanded folders does not open 200 sockets.
* `flattenTree` is memoised on `[rootPath, rootEntries, nodes, expanded,
  sortField, sortDirection, query]`. The reducer returns identity-stable state
  for no-op actions, so an `fs` signal for an unrelated directory re-renders
  nothing.
* `FileRow` gets `React.memo` with the default shallow comparison. Its props are
  all primitives, the `entry` object reference is stable per listing, and the
  handlers are `useCallback`-stable in the panel — so expanding one folder
  re-renders the new rows, not the other 500. (Today's row is not memoised and
  does not need to be; with a tree it does.)
* Sorting cost: `sortEntries` is `O(n log n)` per level per memo run, on data
  already in memory. At the caps above that is bounded by 5000·log(5000).

### 7.5 The tripwire

If any of these turns out to be wrong in the wild, the fix is a windowed
`<tbody>` (fixed 36 px row height makes windowing trivial: `h-9` is a constant,
`FileRow.tsx:101`), not a redesign of the data model — `TreeRow[]` is exactly the
shape a virtualiser wants.

---

## 8. Test plan

### 8.1 `test/frontend/fm-tree.test.ts` (new, pure, no DOM)

Unit tests for `lib/fm-tree.ts` — the reason the reducer and the flatten are
pure exports.

`flattenTree`:
1. no expansions → the rows equal the level-0 entries, `depth === 0` for all.
2. one expanded folder → its children appear directly under it at `depth === 1`,
   before the folder's next sibling.
3. children are sorted per level with `foldersFirst`, independently of the
   parent's position.
4. an expanded folder whose node is missing/loading emits **no** child rows and
   sets `loading` on the parent row.
5. an expanded folder whose node is `ready` and empty emits one
   `status: "empty"` row.
6. an expanded folder whose node is `error` emits one `status: "error"` row
   carrying the message.
7. filter: a query matching only a nested child keeps the ancestor folder row
   visible and drops non-matching siblings.
8. filter: a query matching nothing inside an expanded folder drops the folder
   too (unless the folder's own name matches).
9. `visiblePaths` contains entry rows only, in render order, and never a status
   row.
10. `MAX_TREE_ROWS`: a synthetic tree over the cap returns exactly
    `MAX_TREE_ROWS` rows and `truncated: true`.
11. `MAX_TREE_DEPTH`: a row at the cap has `expandable === false`.
12. a `escapesRoot` symlinked directory has `expandable === false`; a symlink to
    a directory *inside* the root has `expandable === true`.

`treeReducer`:
13. `expand` is identity-stable when the path is already expanded.
14. `expand` past `MAX_EXPANDED_PATHS` evicts the oldest non-ancestor.
15. `collapse` keeps descendants in `expanded` (re-expanding restores the shape).
16. `prune` removes a path, its descendants and their nodes — and leaves
    `/a/docs2` alone when pruning `/a/docs`.
17. `remap` re-keys nodes and expanded paths from `from` to `to`, prefix-safe.
18. `invalidate` keeps `entries` and sets `status: "idle"`.
19. `set-root` drops unrelated nodes and applies the `MAX_CACHED_NODES` LRU.

### 8.2 `test/frontend/tree.test.tsx` (new, jsdom, through the real panel)

Same harness as the other frontend suites: `loadPluginApp(() =>
import("../../app"))`, `renderSlot`, an rpc stub whose `listDir` answers per
path, plus `beforeEach` calls to `resetPanelSnapshot()`, `resetUploadManager()`,
**`resetTreeStore()`** and `window.localStorage.clear()`.

Rendering & lazy loading:
1. a folder row renders a chevron; a file row renders none
   (`queryAllByTestId("fm-chevron")` count and `data-fm-path` association).
2. clicking the chevron issues exactly one `listDir` for that folder and renders
   its children indented (`data-fm-depth="1"`), while the current directory's own
   rows stay put and `currentPath` (`data-current-path`) does not change.
3. clicking it again removes the child rows and issues **no** new `listDir`
   (cache hit); re-expanding is instant.
4. `aria-expanded` flips on the row and the chevron.
5. a failing `listDir` renders `fm-tree-error` with the domain message and a
   `Retry loading <name>` button that re-issues the call successfully.
6. an empty folder renders `fm-tree-empty`.
7. two folders expanded at once produce a correctly ordered, depth-major row
   list.

Interaction:
8. clicking the chevron does **not** change the selection (`data-selected`
   unchanged on every row).
9. double-clicking the folder row still navigates (`toPluginPanel` called), and
   double-clicking the chevron does not.
10. `ArrowRight` expands a collapsed folder, then moves focus to its first child;
    `ArrowLeft` collapses it; `ArrowLeft` on a nested row moves focus to the
    parent row; `Alt+ArrowLeft` still navigates to the parent directory.
11. `Shift`+click across an expanded boundary selects the flattened range
    (parent + its visible children + the next sibling).
12. `Ctrl/Cmd+A` selects nested rows too; `Delete` then sends **one**
    `deleteEntries` carrying paths from both depths.
13. collapsing a folder deselects its hidden children (a following `Delete` sends
    only the still-visible paths).
14. Collapse all clears every expansion in one click and is disabled when
    nothing is expanded.

Composition with the rest:
15. dragging a nested row starts a drag with its absolute path in both flavours.
16. dropping onto a **nested folder** row calls `moveEntries` with that folder as
    `destinationDir`.
17. dropping onto a **file** row at depth 1 resolves to its parent folder, not to
    the current directory; at depth 0 it still resolves to the current directory.
18. hovering a collapsed folder for `AUTO_EXPAND_HOVER_MS` during a drag expands
    it (fake timers), and leaving before that does not.
19. an external file drop on a nested folder uploads with `dirPath` = that
    folder.
20. an `fs` signal naming an **expanded, cached** folder refetches exactly that
    folder (one extra `listDir`) and leaves the current directory's fetch count
    alone; a signal naming an unlisted folder refetches nothing.
21. a realtime reconnect refetches every cached expanded node once.
22. toggling hidden files re-issues `listDir` for the expanded node with
    `showHidden: true`.
23. changing the sort column re-orders children **without** any new `listDir`.
24. the filter keeps an expanded folder visible when only its child matches.
25. renaming an expanded nested folder keeps it expanded under the new name
    (`remapPrefix`), and its rename dialog validates against *its own* siblings,
    not the current directory's.
26. deleting an expanded folder removes its rows and its expansion.
27. a move of an expanded folder collapses it (no stale node).

Persistence:
28. expansions survive an unmount/remount of the slot (tier 1).
29. expansions survive a fresh `loadPluginApp` when `localStorage` holds the key
    (tier 2), and a corrupt/oversized value degrades to an empty tree instead of
    throwing.
30. expanding past `MAX_EXPANDED_PATHS` evicts the oldest and the persisted array
    never exceeds the cap.

### 8.3 What must not regress (run these, do not reason about them)

Whole existing suites, unchanged files, all must stay green:

* `test/integration/plugin-factory.test.ts` — 17 rpc methods, 2 http routes, 1
  cron. **No backend change means this file is not edited.**
* every `test/backend/*` suite — untouched.
* `test/frontend/selection.test.tsx` — especially "selects every visible row with
  Ctrl+A", "restricts Ctrl+A to the rows the filter left visible", "marks the
  header checkbox indeterminate", "confirms once for N items and issues a single
  deleteEntries call".
* `test/frontend/keyboard.test.tsx` — "goes to the parent with Backspace and with
  Alt+ArrowLeft", "leaves F5 and Ctrl+R to the browser", "skips the whole map
  while the event target is a text input", and the four clipboard cases.
* `test/frontend/panel.test.tsx` — "refetches exactly once when an fs signal
  names the current directory", the `${ROOT}/elsewhere` no-refetch assertion,
  "sorts by size client-side, without another listDir", "filters the visible rows
  client-side as the user types", the truncation banner, the ErrorBanner
  `getByRole("button", { name: "Retry" })` lookup.
* `test/frontend/dragdrop.test.tsx` — "refuses to drop a row onto itself", "never
  treats a link that leaves the root as a drag source or a drop target",
  breadcrumb drops.
* `test/frontend/uploads.test.tsx` — drop target resolution at depth 0.
* `test/frontend/menus.test.tsx`, `dialogs.test.tsx`, `header.test.tsx`,
  `registration.test.tsx` — untouched behaviour.

Gate for the whole feature: `npx tsc --noEmit` = 0 errors, `npm test` = all files
green with the two new suites, `bb plugin build` clean, and a manual pass in the
running panel (expand, collapse, drag onto a nested folder, restart bb, confirm
the tree comes back).

---

## 9. File-by-file change list

### Backend: **NO CHANGES.** Zero files.

`contract.ts` (frozen), `server.ts`, `src/rpc.ts`, `src/listing.ts`,
`src/mutations.ts`, `src/root.ts`, `src/signals.ts`, `src/settings.ts`,
`src/jobs.ts`, `src/uploads.ts`, `src/http-routes.ts`, `src/archives.ts`,
`src/errors.ts`, `test/backend/**`, `test/integration/**`, `package.json`
version aside — none of them is opened. The proof is §2.1: `listDir` already
lists one arbitrary directory, `entrySchema` already carries the kind flags, the
`fs` channel already publishes changed directories, and the expanded set is
deliberately not server-persisted.

### Frontend

| File | Status | Change |
| --- | --- | --- |
| `lib/fm-tree.ts` | **new** | `TreeNode`, `TreeState`, `TreeRow`, `TreeAction`, `treeReducer`, `flattenTree`, all §1.5 constants. Pure; imports only `contract`, `lib/fm-paths`, `lib/errors` and `sortEntries`/`matchesQuery` from `hooks/useDirectory`. |
| `hooks/useTree.ts` | **new** | `useTree(args): UseTreeResult`, the load loop with `LOAD_CONCURRENCY`, the second `useRealtime(FS_CHANNEL)` subscription + reconnect watcher, the two-tier persistence, `nodeEntries`, `resetTreeStore()`. |
| `components/FileRow.tsx` | edit | new props `depth`, `expandable`, `expanded`, `loadingChildren`, `onToggleExpand`; chevron slot + placeholder; `paddingInlineStart`; `aria-level` / `aria-expanded` / `data-fm-depth`; wrap the export in `React.memo`. No change to the checkbox, size or modified cells. |
| `components/FileTable.tsx` | edit | prop `entries: readonly FileEntry[]` → `rows: readonly TreeRow[]`; render the `status` rows via a new local `TreeStatusRow`; `role="grid"` → `role="treegrid"`; new props `onToggleExpand`, `onRetryNode`; select-all counting over entry rows. `..` row, skeletons, sort headers untouched. |
| `components/FileManagerPanel.tsx` | edit | mount `useTree`; `useSelection(tree.visiblePaths)`; rebuild `entryByPath` from `tree.rows`; stop passing `query` to `useDirectory`; `ArrowRight`/`ArrowLeft` in the keyboard map; depth-aware `dropTargetFor` + auto-expand-on-hover timer; `tree.pruneSubtree` after delete/move, `tree.remapPrefix` after rename; `siblingNames()` for `RenameDialog`; `tree.refreshAll()` on manual refresh; the rows-truncated strip; pass the new props to `FileTable`. |
| `components/Toolbar.tsx` | edit | one ghost icon button "Collapse all folders" (`Minimize2`, `data-testid="fm-collapse-all"`, `disabled` when nothing is expanded); two new props `expandedCount`, `onCollapseAll`. |
| `components/BackgroundContextMenu.tsx` | edit | one menu item "Collapse all folders" with the same disabled rule; one new prop pair. |
| `hooks/useDirectory.ts` | **unchanged** | Still owns level 0. The panel simply stops passing `query`. |
| `hooks/useSelection.ts` | **unchanged** | Index-based over whatever ordered list it is handed. |
| `hooks/useClipboard.ts` | **unchanged** | Absolute paths, depth-agnostic. |
| `lib/fm-paths.ts` | **unchanged** | `isDescendant`, `isSameOrDescendant`, `dirname`, `isInsideRoot`, `normalizePath` are exactly the primitives the tree needs. |
| `components/panel-bus.ts` | **unchanged** | Collapse-all lives in the panel body, so no snapshot field and no command. |
| `app.tsx` | **unchanged** | |
| `test/frontend/fm-tree.test.ts` | **new** | §8.1 |
| `test/frontend/tree.test.tsx` | **new** | §8.2 |
| `README.md` | edit | document the chevron, the keyboard additions, the `Ctrl+A`-now-includes-nested-rows change, and that the filter does not search collapsed folders. |
| `package.json` | edit | version bump only (`0.1.x` → `0.2.0`). Author stays **Foma**. |

---

## 10. Explicitly out of scope (do not build in this pass)

* Recursive **Expand all** (unbounded `listDir` fan-out). The cached-only
  `Alt`+click variant is the cheap follow-up.
* Wiring `searchDir` into the toolbar filter so matches inside collapsed folders
  are found. Contract support already exists; it is a separate feature with its
  own UI (result list vs. tree).
* Per-node `writable` driving `RowContextMenu` for nested rows (§5.9).
* "Paste into this folder" as a distinct row-context-menu item (§5.3).
* Indent guides (§3.3).
* Row virtualisation (§7.5).
* Persisting the expanded set server-side — would require unfreezing
  `contract.ts`.
