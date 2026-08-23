# PATHBAR-SPEC — remember where I was, and let me type a path (v0.4.0)

Two user-visible features, one release:

1. **Location memory** — the panel reopens in the folder you were last in, across
   panel navigation, page reloads and bb restarts.
2. **Path bar** — a browser-style editable address line in the toolbar strip that
   accepts a pasted path, including a path to a **file**.

This document is additive to `SPEC.md` (v0.1) and `TREE-SPEC.md` (v0.2). Neither of
those is edited. Where this document changes a rule they state, it says so
explicitly and quotes the rule.

Everything below is written against the code that exists at v0.3.1. File and symbol
references are literal; if a reference does not resolve, the design has drifted from
the tree and the drift is the bug.

---

## 0. What exists today (verified, not assumed)

Read before designing; re-read before implementing.

* **The route is the location.** `FileManagerPanel({ subPath })` derives
  `currentPath = subPathToAbsolute(subPath, root)` (`FileManagerPanel.tsx:201`) and
  every move is `navigateRef.current.toPluginPanel(PANEL_PATH, { subPath })`
  (`navigateTo`, `FileManagerPanel.tsx:~438`). There is no second copy of "where am
  I". The panel lives at `/plugins/file-manager/files/*` (`PANEL_PATH = "files"`).
* **The start folder already redirects, once, on a cold open.** In the bootstrap
  effect:

  ```ts
  if (subPathRef.current === "" && !isSamePath(result.startFolder, result.root)) {
    navigateRef.current.toPluginPanel(PANEL_PATH, {
      subPath: absoluteToSubPath(result.startFolder, result.root),
      replace: true,
    });
  }
  ```

  The `subPath === ""` guard is already the "an explicit link wins" rule. Feature 1
  changes *what* that branch navigates to, not *when* it runs.
* **The expanded set is already persisted, two tiers**, in `hooks/useTree.ts` module
  scope: `sessionExpanded: string[] | null` (tier 1, survives a remount inside one
  page session) over `window.localStorage[EXPANDED_STORAGE_KEY]` (tier 2, survives a
  reload/restart), debounced 250 ms, flushed on unmount, every access in
  `try/catch`, with an exported `resetTreeStore()` test seam. TREE-SPEC §6 is the
  rationale. **Feature 1 reuses this mechanism; it does not invent a second one.**
* **The breadcrumb strip is not only navigation.** Every crumb in
  `components/Breadcrumbs.tsx` carries `onDragOver` / `onDragLeave` / `onDrop` and
  `data-fm-crumb`, i.e. it is an internal *and* external drop target (SPEC §8.4).
  Dropping a row on "Home" moves it to the root.
* **`statPath` exists and is enough for the path bar.** `src/listing.ts#statPath`:
  `normalize()` the input; if it equals the root, return the root entry with
  `parentPath: null`; otherwise `resolveLink()` (realpaths the *parent chain*, then
  `lstat`s the final component **without following it**) and return
  `{ entry, parentPath }`.
* **Errors already have a code and a sentence.** Backend handlers throw
  `Error("<code>: <message>")`; `lib/errors.ts#parseRpcError` recovers the code and
  `describeErrorCode` maps it to one user sentence. `errorToastText` is the
  everything-else path.
* **The root is `homedir()`**, resolved once by `src/root.ts#initRoot`, published to
  the panel by `getState.root` and into `lib/fm-paths.ts#setClientRoot`. No
  user-facing string may contain a literal root path: use
  `lib/fm-paths.ts#rootPhrase()`.
* **The panel's keyboard map is one handler** on the panel root
  (`handleKeyDown`), and its very first statement is
  `if (isTypingTarget(event.target)) return;`.
* **The header slot cannot see the panel.** `HeaderActions` talks through
  `components/panel-bus.ts`. Nothing in this document needs the title bar, so the
  bus is untouched.

---

## 1. LOCATION MEMORY

### 1.1 What is remembered — and what deliberately is not

| Thing | Remembered? | Why |
| --- | --- | --- |
| The absolute path of the last folder the panel **successfully listed** | **Yes** | This is the feature. |
| The expanded-folder set | **Already is**, unchanged | `hooks/useTree.ts` persists it as one flat set of absolute paths, independent of the current folder. Restoring `~/projects` therefore restores the expansions under it *for free*, because `flattenTree` renders whichever expanded paths fall under the current root. Storing a second, per-folder copy would be a second source of truth for the same fact. |
| Scroll position of the listing | **No** | The table is not virtualised (TREE-SPEC §7.1) and rows below an expanded folder arrive asynchronously (`useTree`'s load loop is breadth-first and capped at `LOAD_CONCURRENCY`). A restored `scrollTop` would be applied against a list that is still growing and would then jump — worse than not restoring it. The panel already scrolls the *focused* row into view (`focusRow` in the `selection.focus` effect), which is the part that matters. Hook for later: §1.10. |
| Selection | **No** | Selection is the operand of destructive keys: `Delete` deletes it and `F2` renames it (SPEC §8.3). Restoring a selection across a restart means a user can press `Delete` on a set they did not choose in this session. Refused on safety grounds, not on cost. The path bar's own "reveal this file" selection (§5.3) is within-session and is never persisted. |
| Sort field / direction, hidden-files, confirm-on-delete | **Already are**, unchanged | They are plugin settings (`savePreferences`), not view state. |
| The filter box (`query`) | **No** | SPEC §8 already keeps it out of the URL on purpose ("a `?` in a file name would break it"); it is per-visit state. |

### 1.2 Where it is stored, and why

**Decision: client-side, two tiers, the exact mechanism `hooks/useTree.ts` already
uses for the expanded set — module scope over `window.localStorage` — extracted into
one shared primitive so there is one implementation, not two.**

Rejected alternatives, on the record:

* **Plugin settings (`savePreferences`).** It would survive a browser-profile wipe,
  but every folder change would be an RPC that calls
  `bb.sdk.plugins.updateSettings`, which makes the server broadcast
  `plugins-changed`, which invalidates the app's whole plugin-settings query
  (`SettingsSection.tsx` documents this chain). Writing view state on every
  double-click into a store whose write is an app-wide cache invalidation is
  abuse of the settings channel. It is also the wrong lifetime: the start folder is
  a *decision*, the last folder is a *trace*.
* **`bb.storage.kv`.** SPEC §7.2 says it is not used, and reaching it needs an RPC
  round trip on bootstrap — one more thing between `getState` and the first paint,
  for a value the client can read synchronously.
* **A second, private localStorage helper next to the tree's.** Two copies of the
  same debounce/flush/quota/try-catch logic, drifting independently. No.

**The extraction.** `lib/fm-store.ts` (new) holds the primitive that
`hooks/useTree.ts` currently inlines:

```ts
export interface SessionStore<T> {
  /** Tier 1 if warm, else tier 2, else the fallback. Never throws. */
  read(): T;
  /** Tier 1 only — synchronous, for a remount inside one page session. */
  remember(value: T): void;
  /** Tier 1 + tier 2. Never throws; a denied storage degrades to tier 1. */
  write(value: T): void;
  /** Test seam: forget tier 1 so the next read goes to storage. */
  reset(): void;
}

export function createSessionStore<T>(options: {
  key: string;
  fallback: () => T;
  /** Parses the raw JSON value; returns `null` to reject it. */
  parse: (raw: unknown) => T | null;
  /** Serialized payloads larger than this are dropped, never written. */
  maxBytes: number;
}): SessionStore<T>;
```

Rules carried over verbatim from TREE-SPEC §6, because they are load-bearing:

* every `localStorage` access inside `try/catch` — a throw inside a slot component
  kills the plugin's UI for the whole session (SPEC §8.1);
* a corrupt row degrades to the fallback, silently;
* the serialized payload is size-capped before the write, never after;
* the key is namespaced `bb-plugin-file-manager:<what>:v1`, so a shape change is a
  new key rather than a migration.

`hooks/useTree.ts` is refactored onto it in the same pass, with **no behaviour
change**: `EXPANDED_STORAGE_KEY`, `EXPANDED_STORAGE_MAX_BYTES`,
`MAX_EXPANDED_PATHS` slicing, the 250 ms debounce, the unmount flush and the
exported `resetTreeStore()` all keep their current names, values and semantics.
The existing `expanded-set persistence (§6)` block in
`test/frontend/tree.test.tsx` is the regression gate for that refactor and must not
be edited to make it pass.

### 1.3 The stored shape

`lib/last-folder.ts` (new):

```ts
export const LAST_FOLDER_STORAGE_KEY = "bb-plugin-file-manager:last-folder:v1";
/** A path is bounded by PATH_MAX; this is the JSON envelope's ceiling. */
export const LAST_FOLDER_MAX_BYTES = 8 * 1024;

export interface RememberedFolder {
  /** Absolute, as the backend resolved it (`listDir`'s answer, not the route). */
  path: string;
  /** The hard root the path was recorded under. */
  root: string;
}
```

Stored JSON: `{"path":"/…/projects/site","root":"/…"}`.

`root` is stored for one reason: the same browser profile can, over time, talk to
two bb hosts with different homes (a laptop home and a container home). Comparing
the stored `root` with `getState().root` turns "a path that happens to look
plausible" into "a path recorded under a different root" — which is dropped, not
guessed at. `parse` rejects anything that is not an object with two non-empty
strings.

### 1.4 When it is written

**Write the folder the backend confirmed, not the folder the route names.**

The write is a `useEffect` in `FileManagerPanel` keyed on `directory.data`:

```ts
useEffect(() => {
  const listed = directory.data?.path;
  if (!listingEnabled || listed === undefined || root === SEPARATOR) return;
  const written = lastFolderWrittenRef.current;             // already recorded?
  if (written !== null && written.path === listed && written.root === root) return;
  lastFolderWrittenRef.current = { path: listed, root };
  rememberLastFolder({ path: listed, root });               // tier 1, synchronous
  if (lastFolderTimerRef.current !== null) clearTimeout(lastFolderTimerRef.current);
  lastFolderTimerRef.current = window.setTimeout(() => writeLastFolder({ path: listed, root }), 250);
}, [directory.data, listingEnabled, root]);
```

plus the same unmount flush `useTree` uses, so a folder opened less than 250 ms
before the panel goes away still survives.

Two details of that effect are load-bearing, and both were added after the 0.4.0
review found them missing:

* **A repeat listing of the folder already recorded writes nothing.**
  `directory.data` gets a fresh identity on *every* refetch — each `fs` signal,
  each realtime reconnect, each finished job — and the naive effect turned that
  into one `localStorage` write per signal in any folder a build or a script is
  writing to. Worse, it made the settings section's "Forget the remembered
  folder" (§1.9) a lie: the first refetch of a still-open panel put the row
  straight back. Comparing against the last value written is what fixes both.
* **The debounce timer is held in a ref, not in the effect's cleanup.** With the
  dedupe above, the effect re-runs (and so would cancel its own cleanup timer) on
  refetches it deliberately ignores, which would leave a genuine pending write
  cancelled and never rescheduled. The timer is therefore cleared only when a
  *different* folder arrives, and on unmount.

**Nothing is listed, and therefore nothing is recorded, while the bootstrap
redirect is in flight.** `setReady(true)` and the `replace` navigation of §1.5
happen in the same batch, so for at least one render the panel is `ready` while
the route still says "the root". Listing it there costs a full `readdir` of the
home directory that nobody asked for, and — since that answer is a perfectly good
`directory.data` — records the root as "where you were", which an unmount inside
that window then flushes over the real memory. `listingEnabled = ready &&
!redirectPending` gates `useDirectory` and `useTree` until the route the panel
asked for is the route it is on; `redirectPending` clears on *any* `subPath`
change (not just the expected one) and on any navigation of the user's own, so a
host that routes elsewhere cannot leave the panel in a permanent skeleton.

Why `directory.data.path` and not `currentPath`:

* `listDir` returns `dirReal` — the **realpath'ed** directory (`src/listing.ts`).
  Storing that means a route that went through a symlink is remembered as the thing
  it actually opened.
* A route the backend refused (`not_found`, `path_escape`) never produces
  `directory.data`, so **a folder that failed to open is never remembered**. This is
  what stops a bad deep link from poisoning the memory for the next open.
* It is already in hand. No extra RPC, no extra state.

The memory is written **regardless of the `restoreLastFolder` setting** (§2).
Writing costs one localStorage row; reading is what the setting gates. That makes
the toggle non-destructive: flip it on and the folder you were in a minute ago is
still there.

### 1.5 When it is read — `pickInitialFolder`

The decision is a pure function in `lib/last-folder.ts`, so it can be tested without
a renderer:

```ts
export type InitialFolderSource = "deep-link" | "memory" | "start-folder";

export interface InitialFolderChoice {
  /** Absolute path the panel should open. */
  path: string;
  source: InitialFolderSource;
}

export function pickInitialFolder(args: {
  /** The panel's `subPath` prop as delivered by the host. */
  subPath: string;
  remembered: RememberedFolder | null;
  /** `getState().startFolder` — already validated by the backend. */
  startFolder: string;
  /** `getState().root`. */
  root: string;
  /** `getState().preferences.restoreLastFolder`. */
  restoreLastFolder: boolean;
}): InitialFolderChoice;
```

Rules, in order — the first that matches wins:

| # | Condition | Result | Notes |
| --- | --- | --- | --- |
| 1 | `subPath !== ""` | `{ path: subPathToAbsolute(subPath, root), source: "deep-link" }` | **An explicit link always wins.** The caller does not navigate at all in this case — it is already there. |
| 2 | `restoreLastFolder === false` | `{ path: startFolder, source: "start-folder" }` | The memory is not even read. |
| 3 | `remembered === null` | `{ path: startFolder, source: "start-folder" }` | First ever open, or after "Forget the remembered folder". |
| 4 | `remembered.root !== normalizePath(root)` | `{ path: startFolder, source: "start-folder" }` | Recorded against a different home. |
| 5 | `!isInsideRoot(remembered.path, root)` | `{ path: startFolder, source: "start-folder" }` | Hand-edited or corrupt row. |
| 6 | otherwise | `{ path: normalizePath(remembered.path), source: "memory" }` | **Memory beats the start folder.** |

`isInsideRoot` is called here with the **explicit** `root` from `getState`, never
with its default argument. The default reads `getClientRoot()`, which is still `"/"`
until the first panel bootstrap runs — under `"/"` every absolute path passes, so
the guard would be a no-op on a genuinely cold start. (`useTree`'s hydrate has the
same shape and is only saved by the fact that a corrupt row is rare; do not copy
that pattern here.)

The bootstrap effect becomes:

```ts
setClientRoot(result.root);
setState(result);
…
const choice = pickInitialFolder({
  subPath: subPathRef.current,
  remembered: readLastFolder(),
  startFolder: result.startFolder,
  root: result.root,
  restoreLastFolder: result.preferences.restoreLastFolder,
});
if (choice.source !== "deep-link" && !isSamePath(choice.path, result.root)) {
  restoreRef.current = choice;                      // arms the §1.6 fallback
  navigateRef.current.toPluginPanel(PANEL_PATH, {
    subPath: absoluteToSubPath(choice.path, result.root),
    replace: true,
  });
}
```

`replace: true` is kept: the restore is not a step in the user's history.

**The root-vs-empty ambiguity, stated rather than hidden.** `subPath === ""` means
both "no location given" and "the root". A deep link *to the root* is therefore
indistinguishable from opening the panel from the sidebar, and rule 1 cannot fire
for it: such a link gets the remembered folder. This is accepted for v0.4.0 —
inventing a sentinel (`subPath: "~"`) to disambiguate would put a fake segment in
every URL to serve a case that has no reported use. The user-facing escape hatch is
the "Home" crumb, one click away and always visible.

### 1.6 The remembered folder is gone (deleted, renamed, moved, unreadable)

Existence can only be answered by the backend. Two ways to ask:

* **(a) Pre-check with `statPath` before navigating.** Correct, and costs a full
  extra round trip on *every* cold open of the panel — sequential, because it needs
  `getState().root` first. Rejected: it taxes the common case to pay for the rare
  one.
* **(b) Navigate optimistically and treat the first `listDir` failure as the
  answer.** Costs nothing when the folder is there, which is almost always.
  **Chosen.**

The machinery is one ref and one effect:

```ts
/** Set by the bootstrap when it restored from memory; cleared on first use. */
const restoreRef = useRef<InitialFolderChoice | null>(null);

const RESTORE_FALLBACK_CODES = new Set<FileManagerErrorCode>([
  "not_found", "not_a_directory", "permission_denied", "path_escape", "invalid_path",
]);
```

* The moment `directory.data` lands for the restored path, `restoreRef.current` is
  cleared — the restore worked, nothing else happens.
* If `directory.error` lands instead, for the restored path, with a code in
  `RESTORE_FALLBACK_CODES`: clear `restoreRef`, `forgetLastFolder()`, and
  `navigate.toPluginPanel(PANEL_PATH, { subPath: absoluteToSubPath(startFolder), replace: true })`.
  Then one toast:

  | code | toast |
  | --- | --- |
  | `not_found`, `not_a_directory` | `The folder you were last in is gone. Opened ${label} instead.` |
  | `permission_denied` | `The folder you were last in cannot be opened. Opened ${label} instead.` |
  | `path_escape`, `invalid_path` | `The folder you were last in is no longer reachable. Opened ${label} instead.` |

  `label = startFolderLabel(startFolder, root)` — the helper that already exists in
  `lib/start-folder.ts` and yields `"Home"` at the root, else the root-relative path.
  No literal root path appears in any of these sentences.
* Any other code (`io_error`, a transport failure, an offline backend) is **not** a
  fallback: it is a transient failure of a folder that probably still exists, and
  throwing away the memory over a dropped socket is worse than showing the normal
  error banner with its retry.
* **When the remembered folder *is* the start folder, there is nowhere to fall
  back to.** This is the ordinary state of any install with a start folder
  configured: the first open remembers exactly that folder, so every later open
  restores it. Navigating "to the start folder" would then ask the host for the
  route the panel is already standing on — no route change, no new listing, and
  the banner that was held down waiting for that listing would stay down for
  good, leaving a dead folder rendered as "This folder is empty" with an Upload
  button that cannot work. So: forget the row, suppress nothing, show no toast,
  and let the ordinary `ErrorBanner` and its Retry do the talking. The toast in
  the table above would name the folder that just failed as the folder that
  opened instead, which is worse than silence.

**Do not flash the error banner on the way.** While `restoreRef.current` names the
path that `directory.error` belongs to *and* the code is a fallback code, the panel
renders the loading state, not `ErrorBanner`. The user sees one navigation and one
toast, not an error that repairs itself half a second later. Concretely, the
existing render guard

```tsx
{directory.error === null ? null : <ErrorBanner … />}
```

becomes `{directory.error === null || restoreFallbackMoves ? null : <ErrorBanner … />}`
with `restoreFallbackMoves` derived from the same facts as the effect — including
the "is the start folder somewhere else?" test above, so that the case with
nowhere to go renders its banner immediately instead of waiting for a listing
that will never be requested.

The panel does **not** try to guess where a moved folder went. "Renamed" and
"deleted" are the same event from outside, and a search for a similarly-named
folder would occasionally land the user somewhere confidently wrong.

### 1.7 Everything else that can change under it

* **The user deletes the folder they are standing in**, from inside the panel.
  `deleteEntries` → `fs` signal → `useDirectory` refetches → `not_found` →
  `ErrorBanner` (today's behaviour, unchanged, because `restoreRef` is null by
  then). The memory still holds the dead path; the *next* open takes the §1.6
  fallback. That is the correct division: the fallback belongs to the open, not to
  the deletion.
* **The start folder changes** while a memory exists: nothing happens now; the new
  start folder is what the next `source: "start-folder"` open uses.
* **`restoreLastFolder` is turned off** while the panel is open: nothing happens
  now. It is an open-time decision, and yanking a user out of the folder they are
  reading because they ticked a checkbox on another page is not a feature.

### 1.8 Per-user, per-machine

`localStorage` is scoped to the bb app's origin inside the browser (or the Electron
profile partition). That makes the memory **per operating-system user, per machine,
per browser profile** — never shared, never synced. That is the right scope: the
value is a local filesystem path, and the hard root differs between machines.
The stored `root` (§1.3) makes a mismatch explicit instead of accidental.

Storage denied (a locked-down Electron partition, private mode) degrades to tier 1:
the memory then survives panel navigation and remounts inside the page session, and
resets on reload. No error is shown; there is nothing the user can do about it.

### 1.9 The user-facing "reset"

`components/SettingsSection.tsx` grows a **"Forget the remembered folder"** button,
shown only while `readLastFolder() !== null`. It calls `forgetLastFolder()` — pure
client-side, **no RPC**, no settings write — and then reports "Forgotten. The panel
will open in <label> next time." The section can do this even though the host mounts
it outside the panel's subtree, because `lib/last-folder.ts` is module scope in the
same bundle, exactly like `components/panel-bus.ts`.

That promise only holds because of the dedupe in §1.4. The settings section and the
panel can be on screen at once (a split, a second window), and before the dedupe the
next refetch of the still-open panel — an `fs` signal was enough — wrote the row
straight back. The button now sticks: the panel re-records only when the user
actually moves to a different folder, which is the point at which "where I was" has
genuinely changed again.

### 1.10 Hooks left for later (do not build now)

* Scroll restoration would slot into the same store as `{ path, scrollTop }`,
  applied after `directory.data` lands *and* `rows.length` has been stable for one
  frame. Not in 0.4.0.
* A short list of recent folders (a dropdown on the path bar) is the natural next
  use of the same store; `RememberedFolder` is deliberately an object, not a bare
  string, so growing it into `{ path, root, atMs }` is a `v2` key and not a
  redesign.

---

## 2. THE NEW SETTING

### 2.1 Descriptor

In `src/settings.ts#settingsDescriptors`, declared **immediately after
`startFolder`** so the host's form renders the pair together (the host renders
descriptors in declaration order):

```ts
restoreLastFolder: {
  type: "boolean",
  label: "Reopen the last folder",
  description:
    "Open the folder you were last in instead of the start folder. " +
    "The start folder is used the first time you open the panel, after you forget " +
    "the remembered folder, and whenever the last folder is gone.",
  default: true,
},
```

* **Key**: `restoreLastFolder`. Also the CLI surface:
  `bb plugin config file-manager set restoreLastFolder false`.
* **Default**: `true` — the feature was asked for; a default-off feature nobody
  finds is not a feature.
* The description names *both* folders because the setting is only comprehensible
  as a pair with `startFolder`, and the host's form shows one line of description
  per field.

`FileManagerSettingsValues` gains `restoreLastFolder: boolean`, and
`toPreferences()` returns it. `test/backend/settings.test.ts` asserts
`Object.keys(settingsDescriptors)` exactly, so that list moves too.

### 2.2 Where it appears in the custom settings section

**It is not re-rendered as a second editable control.** `components/SettingsSection.tsx`
exists because bb's declarative form has no path picker; a boolean needs no picker,
and the file's own comment records why two identically-labelled editors of one
setting on one page are a trap ("they read as two different settings"). The host's
checkbox is the only writer.

What the section gains is the one thing the host's form cannot say — **which folder
is in effect right now**:

* A line under the existing "The panel opens here every time." copy, driven by
  `state.preferences.restoreLastFolder` from the section's own `getState` read:
  * `true`  → `Reopening the last folder is on, so this is where the panel opens the first time and whenever the last folder is gone.`
  * `false` → `Reopening the last folder is off, so the panel always opens here.`
  The existing sentence "The panel opens here every time." is only true in the
  second case and is replaced by this pair.
* The **"Forget the remembered folder"** button from §1.9, in the same button row as
  `Browse…` / `Reset to …`, enabled only when a memory exists.

The section already re-reads `getState` when the host's cached settings change
(`isExternalSettingChange` → `refresh()`), so ticking the host's checkbox updates
this copy with no extra wiring. That mechanism keys off `startFolder` today; it
becomes a two-key check (`startFolder`, `restoreLastFolder`) — one line in
`lib/start-folder.ts#isExternalSettingChange`'s call site, not a new mechanism.

---

## 3. THE PATH BAR

### 3.1 Placement, and why a mode toggle rather than a replacement

**Decision: the breadcrumb strip has two mutually exclusive states in the same box.
Crumb mode is the default and is exactly what ships today. Edit mode replaces the
crumbs, in place, with a single-line text input of the same width.**

Replacing the crumbs permanently was considered and rejected on evidence in this
codebase:

* Each crumb is a **drop target** for internal moves and OS drops (SPEC §8.4;
  `data-fm-crumb`, `onDragOver/onDragLeave/onDrop` in `Breadcrumbs.tsx`, exercised by
  `test/frontend/dragdrop.test.tsx`). A text input cannot be one. Dropping the
  crumbs deletes a shipped feature.
* Each crumb is a one-click jump to an ancestor. Typing `..` is not a replacement
  for clicking "Home".
* The toolbar is already tight: the filter box shrinks at `@lg` and the free-space
  label disappears below `@2xl`. Showing both a full path and the crumbs at once
  does not fit.
* Every desktop file manager that shows a path solves it exactly this way
  (Explorer, Nautilus, Dolphin, VS Code's `Ctrl+P`): crumbs by default, text on
  demand.

New component `components/PathBar.tsx` owns the strip and both states. It renders
`Breadcrumbs` unchanged in crumb mode — `Breadcrumbs.tsx` keeps every existing prop
and every existing DOM node, and gains exactly one optional prop
(`onEmptyAreaClick`, §3.2). `Toolbar.tsx` swaps `<Breadcrumbs …/>` for
`<PathBar …/>` and forwards the crumb drag props untouched.

### 3.2 The two visual states

**Crumb mode (idle).**

```
[📂 Home] › [projects] › [site]              [✏️]   [ Filter… ] [Sort] [👁] [⤡] [⟳]  12 GB free
└────────────── nav[aria-label="Breadcrumb"], flex-1 ──────────┘
                                              └ fm-path-edit
```

* The crumbs are byte-for-byte today's markup.
* A new ghost icon button at the end of the strip: icon `Edit`,
  `aria-label="Edit path"`, `aria-pressed={editing}`, `data-testid="fm-path-edit"`,
  tooltip `Edit path (Ctrl+L)`. `h-8 w-8 shrink-0 p-0`, the same shape as the
  hidden/collapse/refresh buttons it sits next to.
* The nav's flex slack — the empty area to the right of the last crumb — is a click
  target that enters edit mode. This is the Explorer/Nautilus gesture and costs one
  handler:

  ```tsx
  onClick={(event) => {
    if (event.target === event.currentTarget) onEmptyAreaClick?.();
  }}
  ```

  A crumb button, and the wrapper `div` around each crumb, are descendants, so the
  target check makes a crumb click impossible to confuse with an empty-area click.
  The nav gets `cursor-text` (passed down through the existing `className` prop —
  `Breadcrumbs` already merges it with `cn`).
* The whole strip gets `title={currentPath}`, so the absolute path is one hover
  away without spending a pixel of width.

**Edit mode.**

```
[📁 /home/…/projects/site                                    ]  [✏️]  [ Filter… ] …
 └ div[role="group"][aria-label="Folder path"] > input#fm-path-input, flex-1
```

* The `<nav>` and every crumb leave the DOM; a `div[role="group"]` with the input
  takes the same box.
* Leading `Folder` icon, `aria-hidden`, purely to keep the visual mass of the strip
  constant between states.
* No "Go" button. `Enter` commits; a second control would be redundant, would steal
  the blur, and would need its own disabled logic.
* On failure the input gets `aria-invalid="true"` and a red ring, and a message box
  appears **absolutely positioned below the input** (`fm-path-error`), so the
  toolbar's height never changes and the table below never jumps. That box is also
  exactly where a completion list would render later (§6).

### 3.3 Entering edit mode

Three routes, all landing in the same `openPathBar()`:

1. **Click the empty area of the crumb strip** — discoverable by accident, which is
   the point.
2. **The `Edit path` button** — the discoverable-on-purpose route, the touch route,
   and a real tab stop.
3. **`Ctrl+L` / `Cmd+L`** — the browser gesture. See §7 for the exact binding and
   for why this one shortcut is handled even from inside a text field.

`openPathBar()`:

* sets `pathEditing = true`;
* seeds the input with `currentPath` — the **full absolute path** (§3.4);
* focuses it and **selects all of it**, in a layout effect, so the very next
  keystroke of a paste-over replaces the whole value;
* when it is called while already editing (a second `Ctrl+L`), it does not reset the
  text — it just re-selects it, matching a browser's address bar.

### 3.4 What it shows

**Idle: the crumbs. On entry: the full absolute path.**

* Not `~/projects/site`. The absolute form is what "Copy folder path" already puts
  on the clipboard, what every backend error message names, and what pastes back
  into a terminal without a shell to expand it. `~` is a shorthand this bar
  *accepts* (§4) but never *produces*.
* Not a shortened/elided form. The value is editable text; eliding the middle of an
  editable string is a bug generator.

### 3.5 Leaving edit mode

| Route | Effect | Focus lands on |
| --- | --- | --- |
| `Escape` | **Revert**: drop the typed text and any error, return to crumb mode. | The grid (`gridRef.current?.focus()`). |
| `Enter` on a value that resolves | Commit and navigate (§5). Leave edit mode. | The grid. |
| `Enter` on a value that fails | **Stay in edit mode**, keep the text exactly as typed, show the inline message, leave the caret where it is. | The input (unchanged). |
| Blur (click elsewhere, `Tab`, window loses focus) | **Revert.** | Wherever the user sent it. Not moved. |
| The `Edit path` button while editing | Revert (it is a real toggle). | The grid. |

**Blur reverts, it does not commit.** A blur is not a decision: it fires when the
user clicks the sort menu, when a row drag starts, when the OS steals the window,
when a toast takes focus. Committing on blur would navigate on an accident, and it
would navigate on a *half-typed* path — the worst possible input. A revert is
cheap to undo (`Ctrl+L` regenerates the text from the current folder); a wrong
navigation costs a round trip, drops the selection and re-lists a folder. Every
shipped path bar behaves this way.

Two carve-outs, both guarded by a ref so they cannot be confused with a user blur:

* the blur that the **commit itself** causes (focus moves to the grid) must not
  re-run the revert;
* focus moving *into* the strip's own popover is not a blur. There is no popover in
  0.4.0, so this is a comment on the guard, not code.

**A row drag while editing is safe**: `mousedown` on a row blurs the input, which
reverts, which puts the crumbs back before the first `dragover` — so the crumb drop
targets are present for the whole drag.

**An IME composition is not input yet.** With a Japanese, Chinese or Korean IME
the `Enter` that accepts a candidate and the `Escape` that cancels a composition
both arrive as ordinary `keydown`s, flagged `isComposing` (and carrying the legacy
`keyCode: 229`). Committing there would navigate to a half-transliterated path and
close the bar under the user. The input's `onKeyDown` therefore returns
immediately on such an event and does nothing else — no `preventDefault`, no
`stopPropagation` — leaving the IME to do its job. The panel's own key map is not
reachable from there either: the typing-target guard already covers an `<input>`.

---

## 4. PATH BAR INPUT SEMANTICS

All of this is pure and lives in `lib/fm-pathbar.ts` (new), so it is unit-tested
without a DOM, exactly as `lib/fm-tree.ts` is (TREE-SPEC §1.4). The module imports
`lib/fm-paths.ts` and nothing else — in particular it must not import the SDK, as
`test/integration/frontend-bundle-graph.test.ts` requires of every panel-side
module.

```ts
export type PathInputResult =
  | { kind: "empty" }                                  // nothing typed: just close
  | { kind: "path"; absolute: string }                 // hand this to statPath
  | { kind: "refused"; message: string };              // show it, call nothing

export function parsePathInput(
  raw: string,
  context: { root: string; currentPath: string },
): PathInputResult;
```

### 4.1 The cleanup pipeline, in order

1. **Trim** leading/trailing ASCII whitespace, including a trailing newline (a
   terminal copy usually carries one).
2. **Unwrap one matched pair of quotes**: `"…"` or `'…'`. Shell and file-manager
   copies of a path with spaces are quoted. Exactly one pair, only when the first
   and last character match.
3. **Un-escape shell escapes — narrowly.** If the value was *not* quoted in step 2
   **and** contains the two-character sequence `\ ` (backslash-space), replace every
   `\<char>` with `<char>`. That is the shape a terminal drag-and-drop produces
   (`/…/My\ File.txt`). The guard matters: a backslash is a legal character in a
   POSIX file name, so a blanket un-escape would corrupt a real name. Restricting
   it to values that contain an escaped space makes the false-positive case a file
   literally named with `\ ` in it — accepted, and documented here so it is a
   decision rather than a surprise.
4. **`file:` URLs**: `file:///home/you/x` → strip the scheme, `decodeURIComponent`
   the rest. Accepted, because pasting from a browser's download list or another
   file manager is a real habit. A **non-empty authority** (`file://server/share`)
   is refused: *"That looks like a path on another computer."*
   Any other scheme (`http:`, `https:`, `smb:`, `sftp:`) is refused:
   *"Only paths on this computer can be opened here."* `%`-decoding happens **only**
   on this branch — a literal `%` is legal in a file name and must not be decoded
   out of a plain path.
5. **Windows-shaped input** — `C:\…`, `\\server\share`, or any value containing a
   backslash that survived step 3 and no `/` — is refused:
   *"That looks like a Windows path. This panel opens paths under `${rootPhrase(root)}`."*
   There is no correct translation; a guess would navigate somewhere wrong and look
   deliberate.
6. **Control characters or a NUL byte** → refused: *"That path is not valid."* No
   RPC — `src/root.ts#validateName` would refuse it anyway, and there is no reason
   to spend a round trip learning that.
7. **Empty after all of the above** → `{ kind: "empty" }`. Leaving edit mode with an
   empty box is not an error; it closes and changes nothing.

### 4.2 Resolution

| Input | Resolves to | Note |
| --- | --- | --- |
| `/abs/path` | itself, `normalizePath`'d | |
| `~`, `~/` | the root | |
| `~/x/y` | `<root>/x/y` | |
| anything else (`docs`, `./docs`, `../pics`, `a b/c`) | **`normalizePath(joinPath(currentPath, input))`** | **Relative to the folder on screen**, not to the root. |
| trailing `/`, repeated `//`, `.`, `..` | collapsed by `normalizePath` | `~/a/../b` → `<root>/b` |
| `/` | `"/"` | Then refused by the root check — it *is* outside the root, and saying so is the honest answer. |

**Do not reuse `lib/fm-paths.ts#toAbsolute` for the relative branch, and do not
"fix" it.** `toAbsolute` resolves a bare relative path under the **root**, on
purpose: it mirrors `src/root.ts#normalize` and is what decodes the route's
`subPath`. A path bar must resolve relative input against the **current folder**,
like every shell and every path bar. These are two different resolvers for two
different inputs; changing `toAbsolute` would silently change how every URL in the
panel is decoded. `fm-pathbar.ts` uses `joinPath` + `normalizePath` for its own
branch and `toAbsolute` for the `~` branch only.

### 4.3 The root check happens on the client, before any RPC

```ts
if (!isInsideRoot(absolute, root)) {
  return { kind: "refused", message: `That path is outside ${rootPhrase(root)}.` };
}
```

* **Never navigate**, never call `statPath`. The backend would refuse it anyway
  (`path_escape`), but a refusal the user sees instantly, without a round trip, is
  better — and the test can assert **zero** RPC calls, which is a much stronger
  guarantee than "the message happened to be right".
* `..` climbing out (`~/../../etc`) is caught here, after `normalizePath`.
* A *symlinked* escape cannot be caught here — the client does not resolve links.
  That one comes back from `statPath` as `path_escape`, or from the entry's
  `escapesRoot` flag (§5.2), and is refused there.
* `rootPhrase()` is the only way the root is ever named. It returns
  `"the home folder"` while the root is still unknown, so the sentence is true even
  before `getState` lands.

---

## 5. RESOLVING THE INPUT — `statPath`

### 5.1 The exact contract being relied on

```ts
statPath: {
  input:  z.strictObject({ path: z.string() }),
  output: z.strictObject({ entry: entrySchema, parentPath: z.string().nullable() }),
}
```

`src/listing.ts#statPath`, in full:

* `normalize(input.path)`; if it equals the root, `buildEntry(root)` and
  `parentPath: null`;
* otherwise `resolveLink(input.path)`, which realpaths the **parent chain**, applies
  `validateName` to the last component, `assertInside`s the result, and `lstat`s it
  **without following a final symlink**;
* then `entryFrom`, which fills `kind` (lstat kind — a symlink is `"symlink"`),
  `targetKind` (the resolved kind, from a guarded realpath, or `null`),
  `escapesRoot` (true when the link resolves outside the root or not at all),
  `isHidden`, `archiveFormat`.

Two consequences the path bar depends on and must not re-derive:

* **`escapesRoot` is already computed.** The panel does not need to reason about
  links; it reads the flag, exactly as `openEntry` does today.
* **A missing *parent* throws `not_found` for the parent**, because
  `resolveExisting(dirname)` runs first. The message that reaches the user must
  therefore be phrased about the path the user typed, not about whatever the server
  named — see §5.4.

No new RPC method. **The path bar needs no contract change.**

### 5.2 Commit flow

`onSubmitPath(raw)` in `FileManagerPanel`:

1. `const parsed = parsePathInput(raw, { root, currentPath })`.
2. `kind === "empty"` → close the bar, navigate nowhere.
3. `kind === "refused"` → set the inline message, stay in edit mode, **no RPC**.
4. `kind === "path"` → take a ticket (`pathTicketRef`, the same stale-response guard
   `useDirectory` uses), set a pending state that disables nothing but marks the
   input busy, and `await rpc.call("statPath", { path: parsed.absolute })`.
   A stale answer (the user pressed `Enter` twice, or edited and re-submitted) is
   dropped: **a second `Enter` can never produce two navigations.**
5. On success, branch on the entry:

   | Entry | Action |
   | --- | --- |
   | `escapesRoot === true` | Refuse inline: `That link does not lead anywhere inside ${rootPhrase(root)}.` Do not navigate. (Same rule as `openEntry`.) |
   | a directory — `kind === "directory"`, or `kind === "symlink" && targetKind === "directory"` | Already on that folder? Close the bar and do nothing else. Otherwise `navigateTo(entry.path)`, close the bar, focus the grid. |
   | anything else — `file`, `other`, a symlink to a file | `parentPath === null` is impossible here (only the root has it, and the root is a directory): `navigateTo(parentPath)` unless the panel is already showing it, and **reveal** `entry` (§5.3). |

   A symlink to a directory navigates to the **link's own path**, which is what
   double-clicking that row already does; `listDir` then answers with the realpath,
   so the crumbs settle on the target. Consistent with today — no new rule.

   **A broken link inside the root is refused, not revealed** — an earlier draft of
   this table put it in the reveal row, which the wire cannot support.
   `src/listing.ts#entryFrom` sets `escapesRoot = true` whenever `realpath`
   *throws*, so a dangling or looping link arrives byte-identical to one that
   really resolves outside the root (`escapesRoot: true, targetKind: null` in both
   cases). Telling them apart would need a new contract field, which is not worth
   spending on a dead link; instead the one sentence used for both says only what
   is certainly true of both — the link leads nowhere this panel can open.

   **A commit that does not change the folder does not navigate.** Pressing
   `Ctrl+L` and `Enter` with the seeded value untouched, or revealing a file that
   is in the folder already on screen, used to call `toPluginPanel` without
   `replace` — a duplicate history entry after which "Back" appears to do nothing,
   plus a pointless re-list. The reveal still arms normally; it simply does not
   move the route to where it already is.
6. On failure, map the code (§5.4), show it inline, stay in edit mode with the text
   intact.

### 5.3 Revealing a file

"Reveal" = navigate to the parent, then select + focus + scroll to the row. Three
facts from the existing code shape the implementation:

* `useSelection` **prunes any selected path that is not in `visiblePaths`**. Calling
  `selection.select(file)` before the new listing lands is a no-op that is
  immediately discarded. The reveal must therefore be *pending* until the row
  exists.
* Once `selection.focus` is set, the panel's existing
  `useEffect(() => focusRow(selection.focus), …)` scrolls it into view. Nothing new
  is needed for scrolling.
* `visiblePaths` comes from the **filtered** tree flatten. A row the filter box
  removes is not there.

So, before navigating, fix the two conditions that would make the row invisible —
using `entry` from `statPath`, which already knows:

* **The filter box is not empty** → `setQuery("")`. The user just asked for a
  specific file by name; a stale filter is not an opinion they are still holding.
* **`entry.isHidden && !showHidden`** → `setShowHidden(true)` **in component state
  only — do not call `persist({ showHiddenFiles: true })`**, and do not route it
  through `toggleHidden`, which persists. Plus one toast:
  `Showing hidden files so ${entry.name} is visible.` The eye button now reads
  pressed, so the UI state and the screen agree, and one click undoes it. A reveal
  that silently lands the user in an apparently empty `~/.ssh` is the worse
  outcome; a silently *persisted* preference change is the worse outcome in the
  other direction. This threads between them.

Then:

```ts
pendingRevealRef.current = { path: entry.path, dir: parentPath };
navigateTo(parentPath);
```

and one effect:

* when `visiblePaths` contains the pending path → `selection.select(path)`, clear
  the ref. (`select` sets selected + anchor + focus in one call; the focus effect
  scrolls.)
* when `directory.data?.path` equals the pending `dir` and the listing is no longer
  loading and the path is still absent → clear the ref and toast once:
  * `directory.data.truncated === true` →
    `${name} is in this folder, but the listing was cut off at ${maxListEntries} items. Use the filter to find it.`
  * otherwise → `${name} is not in this folder any more.`
* the ref is cleared unconditionally on any user-initiated navigation, so a stale
  reveal cannot fire two folders later.

The reveal is **announced through the toast layer only** — sonner already renders in
a live region, and every other outcome in this panel is reported the same way. No
new `aria-live` node is introduced for it.

### 5.4 Error → message

The inline message under the input. `parseRpcError(failure).code` drives it, and the
sentence names **the path the user typed** (`parsed.absolute`), never the server's
own path string, because on a missing parent the server names the parent:

| code | message |
| --- | --- |
| `not_found` | `There is nothing at ${typed}.` |
| `not_a_directory` | *(cannot reach here — a non-directory is a reveal, §5.2)* |
| `permission_denied` | `You do not have permission to open ${typed}.` |
| `path_escape` | `That path is outside ${rootPhrase(root)}.` |
| `invalid_path`, `invalid_name` | `That path is not valid.` |
| `io_error` | `The filesystem reported an error. Try again.` |
| any other domain code | `describeErrorCode(code)` — the existing sentence |
| no domain code (transport, offline) | `errorToastText(failure, "Could not open that path.")` |

Typing anything clears the message, so a corrected typo does not sit next to a stale
alert.

---

## 6. AUTOCOMPLETE — NOT IN v0.4.0

**Decision: v0.4.0 ships no folder-name completion.** No `Tab` completion, no
dropdown. Reasons, in the order they matter:

1. **It does not serve the request.** The user asked to *paste a path*. Completion
   serves typing.
2. **The keyboard model is the expensive part, and it is expensive in this panel
   specifically.** A completion list needs `role="combobox"` + `aria-controls` +
   `aria-activedescendant` on the input, arrow keys that must be swallowed before
   they reach the grid's map, a `Tab` that fights the toolbar's tab order, and an
   `Escape` that now means two different things depending on whether the list is
   open. Every one of those is a regression surface over a keyboard map (SPEC §8.3)
   that is currently covered by `test/frontend/keyboard.test.tsx` and works.
3. **The RPC is not cheap and cannot be made cheap here.** Completion needs a
   `listDir` of the typed prefix's parent on every debounce tick. `listDir` is
   uncapped work on the server side of the cap: it `readdir`s the whole directory
   and `lstat`s up to `MAX_LIST_ENTRIES = 5000` entries before it answers. A
   debounce hides the latency; it does not bound the work. Doing this well needs a
   *prefix* method on the backend, which is a contract change, which is exactly what
   this release should not spend.

**The hook left for later**, so this is a deferral and not a dead end:

* `lib/fm-pathbar.ts` exports the pure split the completer will need, and it is
  tested now:

  ```ts
  /** "~/pro" → { dir: "<root>", prefix: "pro" }; "~/projects/" → { dir: "<root>/projects", prefix: "" } */
  export function splitForCompletion(
    raw: string,
    context: { root: string; currentPath: string },
  ): { dir: string; prefix: string } | null;
  ```
* The error box in `PathBar` is already an absolutely-positioned popover anchored to
  the input, sized and stacked correctly. The list renders in that slot.
* The input keeps **`Tab` unbound** — it blurs and reverts, which is the browser
  default — precisely so `Tab` is free to become "complete" without breaking a
  binding anyone learned.
* The input is a plain `<input type="text">` with `autoComplete="off"` (the vendored
  `Input` sets it) and **no `role="combobox"`**. Announcing a combobox that has no
  popup is worse for a screen-reader user than announcing a text field. The role
  changes when the list ships, not before.

---

## 7. KEYBOARD AND FOCUS, WHOLE-HEADER

### 7.1 The one new binding

Added to SPEC §8.3's map:

| Key | Action |
| --- | --- |
| `Ctrl/Cmd+L` | Edit the path (open the path bar, focus it, select all). While it is open: re-select the text. |

Everything else in §8.3 keeps its meaning, including the two deliberate non-bindings
(`F5` and `Ctrl/Cmd+R` stay with the browser) and the two host gestures
(`Alt+←` / `Alt+→` history — note `Alt+←` is *also* the panel's go-to-parent, which
is today's behaviour and is unchanged).

`Ctrl+L` is a genuine steal from the browser's address bar. It is the right steal
for a full-page panel — it is what VS Code, Gmail and every web IDE do — and the
panel is the focused surface when it fires. If the bb shell claims the accelerator
first on some platform, the button (§3.3) and the empty-area click still work, so
the feature degrades rather than disappears.

### 7.2 The one exception to the typing-target guard

`handleKeyDown` currently begins:

```ts
if (isTypingTarget(event.target)) return;
```

`Ctrl+L` must be handled **before** that line, and only that — but *after* a guard
that neither existed nor was needed while every shortcut sat below the typing-target
line:

```ts
// A dialog, a context menu and a dropdown render through a portal: their
// keystrokes bubble up the React tree to this handler while their DOM sits
// outside the panel. None of them are the panel's to read.
const panel = rootRef.current;
if (panel !== null && event.target instanceof Node && !panel.contains(event.target)) return;

const mod = event.ctrlKey || event.metaKey;
if (mod && !event.shiftKey && !event.altKey && (event.key === "l" || event.key === "L")) {
  event.preventDefault();
  openPathBar();          // opens, or re-selects when already open
  return;
}
if (isTypingTarget(event.target)) return;
```

so that `Ctrl+L` works from the filter box and from the path input itself, which is
the behaviour of the thing it imitates. Nothing else moves above the guard. Every
other shortcut stays unreachable from a text field.

Without the portal guard, `Ctrl+L` typed into the "Folder name" field of the New
folder dialog opened the path bar *behind* the modal and pulled the focus out of
Radix's focus trap — the path input is a typing target, so the old ordering let it
through. The guard is written as "bail only when we positively know the event came
from outside the panel", so a missing ref can never take the key map down with it.

### 7.3 Inside the path input

| Key | Handling |
| --- | --- |
| `Enter` | `preventDefault`, commit (§5.2). |
| `Escape` | `preventDefault` + **`stopPropagation`**, revert, focus the grid. |
| `Ctrl/Cmd+A` | Left to the browser — select the text. The panel's select-all is unreachable here because of the typing-target guard. |
| `Tab` / `Shift+Tab` | Left to the browser: moves focus, which blurs, which reverts. |
| anything else | Left to the browser; typing clears the inline error. |

`stopPropagation` on `Escape` mirrors what the filter input already does in
`Toolbar.tsx`. The panel's own `Escape` branch is already unreachable from a text
field, so the stop is defence against a *host*-level `Escape` handler (closing the
page or a dialog) firing behind the bar.

### 7.4 Tab order and focus returns

Crumb mode, left to right: each crumb button (as today) → **`Edit path`** → filter →
sort → hidden → collapse-all → refresh.
Edit mode: **the path input** (the crumbs are gone, so the strip is one tab stop
instead of N) → `Edit path` → the rest, unchanged.

**Focus never lands on `<body>`.** Every route out of edit mode that is not a user
blur ends with `gridRef.current?.focus()` — the grid is `role="treegrid"`,
`tabIndex={0}`, and is the panel's one keyboard widget. (`SettingsSection.tsx`
carries the scar that motivates this rule: `focus()` on a disabled button is a no-op
that drops focus on `<body>`.)

---

## 8. ACCESSIBILITY

**Crumb mode**

* `<nav aria-label="Breadcrumb">` and `aria-current="page"` on the last crumb —
  unchanged.
* `Edit path` button: `aria-label="Edit path"`, `aria-pressed={editing}`, tooltip
  `Edit path (Ctrl+L)` (the tooltip is the only place the shortcut is written down,
  which is why it is not just an icon).
* The empty-area click target is **not** a control: no `role`, no `tabIndex`, not in
  the tab order. It is a mouse convenience; the button is the accessible route. A
  clickable area that keyboard users cannot reach is only acceptable because there
  are two other routes that they can.

**Edit mode**

* Wrapper: `<div role="group" aria-label="Folder path">`. The breadcrumb landmark is
  absent while editing, which is correct — there are no breadcrumbs.
* Input: `id="fm-path-input"`, `type="text"`, `aria-label="Folder path"`,
  `spellCheck={false}`, `autoCapitalize="off"`, `autoCorrect="off"`,
  `enterKeyHint="go"`, `data-testid="fm-path-input"`.
* A visually-hidden hint, `id="fm-path-hint"`, referenced by `aria-describedby`:
  *"Type or paste a path and press Enter. Escape cancels."* It is static, so it is
  read once on focus and never competes with a live region.
* On a failed commit: `aria-invalid="true"` and
  `aria-errormessage="fm-path-error"`, with the message node carrying
  `role="alert"` and `id="fm-path-error"`. `role="alert"` announces it once, when it
  appears; typing removes the node, so a corrected value does not leave a stale
  alert behind.
* Busy state while `statPath` is in flight: `aria-busy="true"` on the group. No
  spinner — the call is a single `lstat` and a spinner that flashes for 8 ms is
  noise.

**Announcements that are not the input**

* The restore fallback (§1.6), the hidden-files auto-enable (§5.3), the reveal miss
  (§5.3) and every other outcome go through `toast` (sonner renders in a live
  region). No new live region is added anywhere. That keeps one announcement channel
  for the panel instead of four competing ones — the same argument
  `SettingsSection.tsx` already makes for its own copy.

---

## 9. TEST PLAN

### 9.1 New: `test/frontend/fm-pathbar.test.ts` (pure, no DOM)

One table-driven suite over `parsePathInput` with `root = "/home/coder"` and
`currentPath = "/home/coder/projects"`:

* absolute inside the root → that path;
* `~`, `~/`, `~/docs` → root, root, `<root>/docs`;
* `docs`, `./docs`, `../pics`, `sub/deep` → resolved **against `currentPath`**;
* `..` from the root → refused as outside;
* `docs/`, `docs//x`, `docs/./x`, `docs/../pics` → collapsed correctly;
* `  /home/coder/a  `, a value with a trailing `\n` → trimmed;
* `"/home/coder/My File.txt"`, `'/home/coder/My File.txt'` → unquoted, spaces kept;
* `/home/coder/My\ File.txt` → un-escaped; `"/home/coder/a\b"` (quoted) → **not**
  un-escaped; `/home/coder/a\b` with no escaped space → **not** un-escaped;
* `file:///home/coder/a%20b` → `/home/coder/a b`;
  `file://server/share` → refused, "another computer";
  `https://example.com/x` → refused, scheme;
* `C:\Users\me`, `\\server\share` → refused, Windows wording, and the message
  contains what `rootPhrase(root)` returns and no other literal path;
* a value with `\u0000` / `\u0007` → refused, "not valid";
* `""`, `"   "` → `{ kind: "empty" }`;
* `/` and `/etc/passwd` → refused as outside, message built from `rootPhrase`;
* every refusal message is asserted to **not** contain a hard-coded home path;
* `splitForCompletion` for `"~/pro"`, `"~/projects/"`, `"doc"`, `""`.

### 9.2 New: `test/frontend/pathbar.test.tsx` (jsdom, through the real panel)

* enters edit mode from the button, from a click on the nav's empty area, and from
  `Ctrl+L` — and **not** from a click on a crumb (that still navigates);
* on entry the input holds the absolute `currentPath` and its whole value is
  selected (`selectionStart === 0 && selectionEnd === value.length`);
* `Escape` reverts, restores the crumbs, moves focus to the grid, and **does not**
  clear a non-empty row selection;
* blur reverts and issues no RPC;
* `Enter` on a folder → exactly one `toPluginPanel` with the right `subPath`, bar
  closed;
* `Enter` on `~/docs` and on `docs` (relative) from `~/projects` resolve to
  different folders — the §4.2 rule, asserted end to end;
* `Enter` on a file → navigates to the parent and, once the parent listing lands,
  that row is selected and focused;
* `Enter` on a hidden file with hidden files off → `showHidden` turns on, the toast
  fires, and **no `savePreferences` call is made**;
* `Enter` on a file while the filter box has text → the filter is cleared and the
  row is revealed;
* `Enter` on a missing path → inline `role="alert"`, text preserved, still in edit
  mode, **zero** `toPluginPanel` calls;
* a path outside the root → refused with the `rootPhrase` wording and **zero RPC
  calls of any kind** (assert `slot.inspection.rpcCalls` length is unchanged);
* a symlink whose `escapesRoot` is true → refused, no navigation, and a broken
  link inside the root gets the same sentence (the wire cannot tell them apart);
* `Enter` with the seeded value untouched, and a reveal of a file in the folder
  already on screen → **zero** `toPluginPanel` calls and no extra `listDir`;
* `Enter` and `Escape` flagged `isComposing` (an IME candidate window) → nothing
  commits, nothing closes, and the same `Enter` after `compositionend` does commit;
* a symlink to a directory → navigates to the link path;
* two `Enter`s in flight → exactly one navigation (stale-ticket guard);
* the crumbs are still drop targets after a revert (drag a row onto "Home" and see
  the `moveEntries` call) — the §3.5 "drag while editing" claim.

### 9.3 New: `test/frontend/last-folder.test.tsx` (jsdom)

* first ever open (empty store) → redirects to the configured start folder, exactly
  as today;
* after visiting `docs`, unmount + remount → opens `docs` with `replace: true`
  (tier 1);
* same, but with `resetLastFolderStore()` between (a cold page load) → still opens
  `docs`, from `localStorage` (tier 2);
* deep link `subPath: "docs"` while the memory says `pictures` → opens `docs` and
  makes **zero** navigate calls (the §1.5 rule 1);
* `restoreLastFolder: false` in `getState().preferences` → opens the start folder,
  **and** the memory is still written (flip it back on and the folder is there);
* a remembered folder whose `listDir` answers `not_found` → one navigation to the
  start folder, the memory is cleared, the toast text matches §1.6, and
  `fm-error-banner` is **never rendered** at any point (assert on the whole
  interaction, not just the end state);
* the same with `io_error` → **no** fallback, the error banner *is* rendered, the
  memory survives;
* a stored row with `root` different from `getState().root`, a row that is not
  inside the root, and a corrupt row → all fall back to the start folder without
  throwing;
* the memory records `listDir`'s answer: point `listDir` at a route whose answer is
  a *different* (realpath'ed) `path` and assert the stored value is the answer;
* a route that only ever errored is never stored;
* an unmount inside the 250 ms debounce window still leaves the row in
  `localStorage` (the flush) — asserted with the 250 ms timer stubbed out, so the
  test proves the flush instead of racing the clock;
* five `fs` signals over the folder on screen → **zero** further `localStorage`
  writes (the §1.4 dedupe);
* `forgetLastFolder()` while the panel is mounted, then an `fs` signal and an
  unmount → the row stays gone;
* between the restore redirect and the host applying it → **zero** `listDir` calls,
  and an unmount in that window leaves the remembered folder intact;
* the remembered folder equals the start folder and is gone → one navigation
  (the redirect itself), no toast, the row cleared, and `fm-error-banner` rendered
  *with* its Retry.

### 9.4 Extended

* `test/frontend/keyboard.test.tsx` — `Ctrl+L` opens the bar from the grid **and**
  from the filter box; `Escape` inside the path input does not reach the selection;
  every existing binding still fires while the bar is idle; and no binding at all
  fires from inside a portalled dialog (§7.2).
* `test/frontend/header.test.tsx` — the toolbar still exposes crumbs, filter, sort,
  hidden, collapse-all and refresh, now with `fm-path-edit` between crumbs and
  filter; the button's `aria-pressed` tracks the mode.
* `test/frontend/settings-section.test.tsx` — the "which folder wins" copy follows
  `restoreLastFolder`; "Forget the remembered folder" clears the store, issues **no**
  RPC, and disables itself afterwards.
* `test/backend/settings.test.ts` — the descriptor key list (asserted exactly),
  the `restoreLastFolder: true` default, `preferences()` carrying it, and
  `savePreferences` still returning a complete `preferences` object.
* `test/integration/plugin-factory.test.ts` — passes unchanged once
  `package.json#version` and `PLUGIN_VERSION` are both `0.4.0`.

### 9.5 Test hygiene this feature forces

`localStorage` and the module-scope tier 1 are shared across tests in a file. The
memory now influences **where the panel opens**, so any suite that mounts the panel
twice can leak a location into the next test — including
`panel.test.tsx`'s existing "redirects to the configured start folder on a cold open
of the root". Every frontend suite that mounts the panel adds to its `beforeEach`,
next to the resets it already performs:

```ts
window.localStorage.clear();
resetLastFolderStore();
resetTreeStore();
```

This is the reason `lib/last-folder.ts` exports a reset seam at all, mirroring
`resetTreeStore` / `resetUploadManager` / `resetPanelSnapshot`.

### 9.6 Must not regress — run these, do not reason about them

* `test/frontend/tree.test.tsx` in full, and the `expanded-set persistence (§6)`
  block in particular — it is the gate on the `lib/fm-store.ts` extraction.
* `test/frontend/dragdrop.test.tsx` — the crumbs are still drop targets.
* `test/frontend/panel.test.tsx` — navigation, the start-folder redirect, the
  hidden toggle persisting.
* `test/frontend/selection.test.tsx`, `menus.test.tsx`, `dialogs.test.tsx`,
  `uploads.test.tsx`, `registration.test.tsx`.
* `test/integration/frontend-bundle-graph.test.ts` — extend its file list with
  `lib/fm-pathbar.ts`, `lib/last-folder.ts`, `lib/fm-store.ts` and
  `components/PathBar.tsx`: none may import `@get-bb/plugin-sdk` as a value.
* `npx tsc --noEmit`, `npm test` (27 files / 536 tests, plus the new ones),
  `env -u BB_CLI bb plugin build .`, `npm run types:check`.

---

## 10. FILE-BY-FILE CHANGE LIST

### 10.1 `contract.ts` — one line, and why it cannot be avoided

```diff
 export const preferencesSchema = z.strictObject({
   showHiddenFiles: z.boolean(),
   confirmOnDelete: z.boolean(),
+  /** Reopen the last visited folder instead of `startFolder` (v0.4.0). */
+  restoreLastFolder: z.boolean(),
   sortField: sortFieldSchema,
   sortDirection: sortDirectionSchema,
 });
```

**That is the entire wire change.** The path bar needs none — `statPath` already
does everything §5 asks of it.

Why the memory cannot be built without it: the panel must decide *where to open*
inside the bootstrap effect, in the same tick it learns the root, before the first
`listDir`. `getState` is the one call that already delivers that tick, and
`preferences` is where the panel's persisted view preferences already live
(`showHiddenFiles`, `confirmOnDelete` are its exact peers). The alternative —
reading `useSettings().values?.restoreLastFolder` in the panel — is a *different*
async source (a host react-query) racing the bootstrap: it either delays the first
listing until both resolve, or opens the start folder and jumps a moment later.
Trading a visible jump for a frozen file is the wrong trade.

`preferencesSchema` is a `z.strictObject` and is the output of both `getState` and
`savePreferences`, so **the backend must return the new key in the same commit** or
the host rejects the handler output as `invalid_output`. That is exactly the rule
the file's own header states ("Any change here is a breaking change: bump the plugin
version and update both sides in the same commit") — hence 0.4.0 on both sides. Both
sides ship from one package and one `contract.ts`, so no mixed-version pair exists in
the field.

**Deliberately *not* added:** `savePreferences.input.restoreLastFolder`. Nothing in
this release writes the setting over RPC — the host's own descriptor form is the
only writer (§2.2). Adding an optional input field later is additive and
non-breaking, so this is not a door being closed.

### 10.2 Backend

| File | Change |
| --- | --- |
| `src/settings.ts` | New `restoreLastFolder` descriptor after `startFolder`; the key in `FileManagerSettingsValues`; return it from `toPreferences()`. Nothing in `SavePreferencesInput`. |
| `server.ts` | `PLUGIN_VERSION = "0.4.0"`. |
| `package.json` | `"version": "0.4.0"`. |
| `src/rpc.ts`, `src/listing.ts`, `src/root.ts`, everything else under `src/` | **No change.** |

### 10.3 Frontend

| File | Change |
| --- | --- |
| `lib/fm-store.ts` | **New.** The two-tier session/localStorage primitive (§1.2), extracted from `useTree`, with the reset seam. |
| `hooks/useTree.ts` | Refactor onto `fm-store.ts`. **No behaviour change**; `EXPANDED_STORAGE_KEY`, `resetTreeStore()`, the cap, the debounce and the unmount flush all keep their names and semantics. |
| `lib/last-folder.ts` | **New.** `RememberedFolder`, `LAST_FOLDER_STORAGE_KEY`, `readLastFolder` / `rememberLastFolder` / `writeLastFolder` / `forgetLastFolder` / `resetLastFolderStore`, and the pure `pickInitialFolder` (§1.5). |
| `lib/fm-pathbar.ts` | **New.** `parsePathInput`, `splitForCompletion`, and the refusal sentences (§4). Imports only `lib/fm-paths.ts`. |
| `components/PathBar.tsx` | **New.** Owns the strip and both states; renders `Breadcrumbs` in crumb mode; owns the input, the error popover and the local draft text. |
| `components/Breadcrumbs.tsx` | One new optional prop, `onEmptyAreaClick?: () => void`, wired through the target-identity check (§3.2). Every existing prop, class and DOM node untouched. |
| `components/Toolbar.tsx` | `<Breadcrumbs …/>` → `<PathBar …/>`, forwarding the three crumb drag props plus `editing`, `onEditingChange`, `onSubmitPath`, `pathError`, `pathInputRef`. |
| `components/FileManagerPanel.tsx` | The memory write effect (§1.4); `pickInitialFolder` in the bootstrap (§1.5); `restoreRef` + the fallback effect + the banner suppression (§1.6); path-bar state, `openPathBar`, `onSubmitPath` and the `statPath` ticket (§5.2); the reveal ref + effect and the two pre-navigation corrections (§5.3); `Ctrl/Cmd+L` above the typing-target guard (§7.2). |
| `components/SettingsSection.tsx` | The "which folder wins" copy and the "Forget the remembered folder" button (§1.9, §2.2); the external-change check extended to the second key. |
| `README.md` | The path bar and its shortcut; the new setting; a short, honest "what is remembered and what is not" paragraph (path yes, expansions yes, scroll and selection no); the version. |
| `app.tsx`, `lib/fm-paths.ts`, `lib/fm-rpc.ts`, `lib/errors.ts`, `components/panel-bus.ts`, `components/HeaderActions.tsx`, `components/FileTable.tsx`, `components/FileRow.tsx`, `hooks/useDirectory.ts`, `hooks/useSelection.ts` | **No change.** In particular, `toAbsolute` is not touched (§4.2). |

---

## 11. RISKS

1. **The `useTree` refactor onto `fm-store.ts` is the only change to shipped
   behaviour in this release.** It is a pure extraction and the existing persistence
   suite is the gate, but it touches the one piece of state a user would notice
   losing. If it goes sideways, ship the memory on its own copy of the primitive and
   deduplicate later — the feature is not worth a tree regression.
2. **`Ctrl+L` may be claimed by the bb shell** on some platform. Degrades to the
   button and the empty-area click; nothing breaks, the shortcut just does not fire.
   Verify in the live app before release.
3. **The optimistic restore (§1.6) trades a round trip for a state machine.** If the
   banner-suppression predicate is wrong in either direction the user sees either a
   flash of "Could not open this folder" (annoying) or a swallowed real error
   (bad). The suppression must be keyed on *both* the restored path and the code
   set, and the test asserts the banner never renders during the whole interaction,
   not just at the end.
4. **Shell-escape un-escaping (§4.1 step 3) has a knowable false positive**: a file
   whose name really contains a backslash followed by a space. Narrowed as far as it
   can be narrowed without giving up the pasted-from-terminal case the user asked
   for. Documented, not hidden.
5. **The root-vs-empty `subPath` ambiguity (§1.5)** means a deep link to the root
   loses to the memory. Accepted, with the "Home" crumb as the escape hatch.
6. **Auto-enabling hidden files on a reveal (§5.3)** changes what the user sees
   without them asking. Mitigated by never persisting it, by the eye button
   immediately reading pressed, and by the toast that says so. The alternative —
   landing them in an apparently empty `~/.ssh` — is worse.
7. **`preferencesSchema` is strict.** Backend and panel must ship together. They
   always do (one package, one `contract.ts`), but a hand-rolled partial install
   would produce `invalid_output` on `getState`, i.e. the panel's bootstrap error
   banner rather than a silent misbehaviour. That is the correct failure mode, and
   it is why the version bump is part of this spec rather than a release chore.
