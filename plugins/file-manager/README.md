# File Manager

A bb plugin that adds a full-page file manager for the machine that runs your
bb server. Browse, upload, download, move, rename and extract files under
your home folder without leaving bb and without a shell.

Everything the panel touches lives under one hard root — the home directory of
the user running bb — and
every path is re-resolved and clamped on the server before a single byte moves.

## What it does

- **Browse** — one directory at a time, with name / size / modified / kind
  columns, sortable headers, and an instant filter over the rows already
  loaded.
- **Expand folders in place** — a chevron on every folder row opens its
  children indented underneath it, without navigating away from the current
  directory. Children are fetched on first open and cached afterwards.
- **Upload** — drag and drop files or whole folders. Uploads are chunked,
  resumable, and keep running while you browse elsewhere in bb.
- **Download** — streamed straight from disk with `Range` support, so a 10 GB
  file costs the browser no memory.
- **Organize** — new folder, rename, delete, cut / copy / paste, drag to move.
  Batch operations report a result per path, and name collisions become
  `name (1).ext` instead of silently overwriting.
- **Extract archives** — `zip`, `tar`, `tar.gz`, `tar.bz2`, `tar.xz` and `7z`
  extract as cancellable background jobs, into a staging directory that is
  checked for containment before anything is committed.
- **Live refresh** — every mutation is published on a realtime channel, so a
  second open panel or a finishing background job updates the listing without
  polling.
- **Hidden files** — dot-files toggle, remembered as a setting.
- **Type or paste a path** — the breadcrumbs turn into an address bar
  (`Ctrl`/`Cmd`+`L`, the pencil button, or a click on the empty space right of
  the last crumb). Paste a path to a **file** and the panel opens its folder
  with that file selected.
- **Reopens where you left off** — the folder you were last in comes back after
  you leave the panel, reload the page or restart bb. A setting turns it off.
- **Pick where it opens** — the plugin's settings page carries a folder
  browser for the start folder, so it is chosen rather than typed.

The panel appears in the bb sidebar as **File Manager** and is routed at
`/plugins/file-manager/files/*`. While uploads are running, the sidebar row
shows how many are in flight. The same file manager also opens as a tab in the
right-hand panel, next to a thread — see below.

## Open it beside a thread

**New tab** → **Actions** → **File Manager**, in the right-hand panel of a
thread or of the New thread screen, opens the file manager as a panel tab —
beside *Start terminal* and *Start side chat*. It is the same file manager, not
a cut-down one: the same listing and tree, uploads and downloads, context
menus, dialogs, drag and drop and keyboard map. Drag a file from your desktop
onto the panel and it uploads into the folder on screen while you keep talking
to the agent.

Two things differ, because a panel is a ~450px column with no title bar of its
own:

- **The actions ride in the toolbar.** Upload, new folder and an overflow menu
  sit at its right end; sort, hidden files, collapse-all and refresh live in
  that menu instead of having their own buttons.
- **The filter folds into a magnifier**, so the path bar keeps a readable
  width. `Ctrl`/`Cmd`+`F` unfolds it; closing it clears the filter.

The folder you are in is kept by the tab itself rather than by the URL, so
navigating folders never takes the thread off screen, and the sidebar page and
a panel tab can stand in different folders at once. Both still share the
settings, the upload queue and the "reopen where I was" memory, because those
belong to the machine, not to a surface.

## Right-click a file link → show me where it is

Right-click any file link in a message and bb's menu offers **Open with File
location**. It opens this file manager in the side panel, in the file's folder,
with the file selected — the "reveal in folder" a chat surface otherwise has no
way to do.

A path that does not exist still works, because that is half of what agents
write. `knowledge-base/backups/*-otlozhena-2026-08-25.md` — a glob, not a file —
opens `knowledge-base/backups/` with `-otlozhena-2026-08-25.md` already in the
filter, so the file it meant is the only row on screen. A file that has since
been renamed or deleted opens the nearest folder that still exists, and says
which one. Only a path outside the home folder is refused outright.

The same menu also lists **Open with Preview + location**: bb's own preview
with one strip on top naming the folder and carrying the same *Open location*
button. That entry exists for a reason worth knowing — bb picks an opener
automatically per extension, and the plugin has to claim extensions to appear
in the menu at all. So the preview wrapper is what a plain click lands on: the
file still opens as a preview, plus one button. Text, config, data, code, web
and image extensions are claimed; `.pdf` is left to the pdf-viewer plugin.

To take an extension back, use **Settings → File openers** and pin *BB preview*
for it.

## Folders expand in place

Clicking the chevron left of a folder row expands that folder underneath it:
the children render indented, and the breadcrumbs, the URL and the current
directory stay where they were. Double-clicking the row still navigates into
the folder — the two gestures are deliberately different.

| Gesture | What happens |
| --- | --- |
| click the chevron | expand / collapse; selection and keyboard anchor do not move |
| `→` on a collapsed folder | expand it |
| `→` on an expanded folder | move the cursor to its first child (nothing while children are still loading, or when the filter left none) |
| `←` on an expanded folder | collapse it |
| `←` on a nested row | move the cursor to its parent row |
| `Alt`+`←`, `Backspace` | go up one directory |
| `Enter` | open: a folder navigates in, a file downloads, an archive opens the extract dialog |
| `Shift`+`F10`, the Menu key | open the context menu for the row under the cursor (the empty-space menu when no row is focused) |
| `Ctrl`/`Cmd`+`L` | edit the path: the crumbs become a text field with the full path selected |
| `Escape` | clear the selection (in the path bar it cancels, in the filter box it clears the filter) |
| Collapse all folders | toolbar button, also an item in the empty-space context menu |

Everything else works the same on a nested row as on a top-level one:
multi-select, the row context menu, rename, delete, cut / copy / paste,
download, drag and drop, and upload. Dragging over a collapsed folder for about
0.7 s springs it open so you can drop deeper; dropping onto a file row resolves
to the folder that row lives in.

Three behaviors worth knowing:

- `Ctrl`/`Cmd`+`A` selects every **visible** row, including expanded children.
  Collapsing a folder deselects the children it hides, so a later delete can
  never touch rows you cannot see. If a batch operation gets both a folder and
  something inside it, only the folder is sent.
- The filter searches what is already loaded. It hides non-matching rows level
  by level and keeps the ancestors of a match visible, but it never opens a
  collapsed folder to look inside it.
- Paste always goes into the current directory, never into the folder the
  cursor happens to sit on.

Which folders are open is remembered per absolute path — across navigation, a
panel remount and a bb restart. It is stored client-side and capped at 200 open
folders. **Collapse all folders** resets it.

## The path bar

The breadcrumb strip has a second state. `Ctrl`/`Cmd`+`L`, the pencil button at
its right end, or a click on the empty space after the last crumb replaces the
crumbs with a text field holding the full absolute path, selected, so a paste
replaces it. `Enter` goes there, `Escape` cancels, and clicking away cancels
too — a blur is not a decision, and a half-typed path is the worst thing to
navigate to. A commit that fails keeps your text and says why underneath.

The crumbs themselves are unchanged: they are still one-click jumps to an
ancestor and still drop targets for a dragged row.

What it accepts:

| You paste | What happens |
| --- | --- |
| `/home/you/projects` | goes there |
| `~`, `~/projects` | `~` is the root — the home folder bb runs as |
| `projects`, `./projects`, `../pics` | resolved against the folder **on screen**, like a shell |
| `"/home/you/My File.txt"`, `'…'` | the quotes come off; the spaces stay |
| `/home/you/My\ File.txt` | a path dragged into a terminal: the escapes come off |
| `file:///home/you/a%20b` | the scheme comes off and `%20` decodes |
| a multi-line paste | the first non-empty line |
| a path to a **file** | opens its folder and selects, focuses and scrolls to that file — it never downloads it |
| a hidden file while hidden files are off | turns them on for this visit only, and says so; your saved setting is untouched |
| a path outside the root | refused on the spot, with no request to the server |
| `C:\Users\you`, `\\server\share`, `https://…` | refused: there is no correct translation, and a guess would land you somewhere wrong |
| a path that does not exist | says so, and leaves your text in the box |

Percent-escapes are decoded only for a `file://` URL — `%` and `\` are legal in
a POSIX file name, so a plain path is taken literally. There is no completion
list yet; `Tab` is deliberately still the browser's.

## Where the panel opens

In order: an explicit link wins, then the folder you were last in, then the
configured start folder.

The last folder is remembered from the listing the server actually answered
with, so a folder that failed to open is never remembered, and a symlinked
route is remembered as the folder it really opened. It lives in this browser
profile alone — never synced, never sent anywhere — because it is a path on
this machine. Set **Reopen the last folder** to off and the panel always opens
the start folder instead; the memory is still kept, so turning it back on
resumes where you were.

If the remembered folder is gone when the panel next opens, it falls back to
the start folder, says so once, and forgets it — no error banner for a folder
you did not ask for. When the folder it lost *is* the start folder there is
nowhere to fall back to, so you get the ordinary "Could not open this folder"
banner and its Retry instead of a message that would name the dead folder twice.
**Forget the remembered folder**, on the plugin's settings page, drops the
memory on demand; it stays dropped while the panel is open, and the panel starts
remembering again the next time you move to a different folder.

Which folders are expanded comes back with it, because that is remembered
separately and by absolute path. The scroll position and the selection are not
restored on purpose: they are a moment, not a place, and a restored selection
would arm `Delete` and `F2` on rows you did not choose this session.

## Requirements

- bb `>= 0.39` with `@get-bb/plugin-sdk >= 0.4.8` (Node 24).
- Archive extraction shells out to `tar`, `unzip` and `7z`/`7za`/`7zz`. Formats
  whose tool is missing are reported as unsupported instead of failing at
  extraction time; everything else works without them.

## Install

From the BB Community marketplace, once the catalog entry
([PR #90](https://github.com/get-bb/marketplace/pull/90)) is merged:

```bash
bb plugin install file-manager
bb plugin list --json | jq '.plugins[] | select(.id=="file-manager")'
```

Straight from git, which builds during install — the released tag, or the tip
of `main`:

```bash
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.6.0 \
  --plugin file-manager --tag-prefix file-manager/
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@main --plugin file-manager
```

From a local checkout:

```bash
git clone https://github.com/xMinor-1/bb-plugins.git
cd bb-plugins/plugins/file-manager
npm install
npm run check          # sdk pin, types, tests, build
bb plugin install path:"$(git rev-parse --show-toplevel)" --plugin file-manager --yes
```

A path install keeps editing live: `bb plugin reload file-manager` picks up
backend changes, and `bb plugin dev .` rebuilds the panel on every save.

## Settings

Change them in bb's settings UI, from the panel, or with
`bb plugin config file-manager set <key> <value>`.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `startFolder` | string | home folder | Absolute path under the root the panel opens on its first open, after you forget the remembered folder, and whenever the last folder is gone — or every time, with `restoreLastFolder` off. Shown in the form as **Start folder (typed path)**, and set with a folder browser by the **Start folder** section below it. Re-validated on every read; a deleted or out-of-root path falls back to the root. |
| `restoreLastFolder` | boolean | `true` | Reopen the folder you were last in instead of the start folder. |
| `showHiddenFiles` | boolean | `false` | Show dot-files and dot-directories. |
| `confirmOnDelete` | boolean | `true` | Ask before deleting. |
| `sortField` | `name` \| `size` \| `modified` \| `kind` | `name` | Default sort column. |
| `sortDirection` | `asc` \| `desc` | `asc` | Default sort direction. |
| `uploadChunkMiB` | `4` \| `8` \| `16` \| `32` \| `64` | `16` | Upload chunk size. Larger chunks are faster on fast links; smaller chunks survive flaky ones. |

Toggles made in the panel are written back through the plugin's own
`savePreferences` method, so they persist without a reload.

### Choosing the start folder

bb's settings form only knows four descriptor types — string, select, boolean
and project — so `startFolder` renders there as a plain text field, labelled
**Start folder (typed path)** for the CLI and for typing a path by hand. The
plugin adds its own **Start folder** section right below that form, on its
detail page in Tools:

- the absolute path the panel will actually open, plus its short name (`Home`
  at the root);
- **Browse…** — the same folder browser the panel uses for *Move to…* and
  *Copy to…*, so a folder is picked, never typed;
- **Reset to …** — writes the root back; the button spells out the path it will
  write, and is disabled when the start folder already is the root;
- **Forget the remembered folder** — drops the "reopen where I was" memory in
  this browser profile. Purely local: no request, no setting written, and it is
  disabled when there is nothing to forget;
- one line saying which of the two folders is actually in effect, because
  `restoreLastFolder` decides that and the checkbox above cannot say it;
- a saved / saving indicator, and the backend's own message inline when it
  rejects a path (outside the root, deleted, or not a folder).

Every one of those buttons writes the same `startFolder` setting through the
same `savePreferences` method, so the section, the panel's *Set as start
folder* action and `bb plugin config file-manager set startFolder <path>` are
interchangeable. Whoever writes it last wins, and nobody is left showing a
stale answer: bb broadcasts the change to every open page, and the section
re-reads the effective folder from the backend then — and again whenever the
page comes back to the foreground.

A start folder that stops working — deleted, renamed, or moved outside the root
— never breaks the panel: the backend logs it and falls back to the root. The
section then shows the folder that will actually open *and* names the saved one
it is not using, so a start folder cannot disappear quietly. That line comes
from the backend's own answer and nothing else: while the backend is opening
the folder the setting names, the section says nothing about it — a path it
stored in `realpath` form, or a copy of the setting the page has not refetched
yet, is not a fallback.

## Uploads

Files are cut into chunks and sent one chunk per request. The server appends
each chunk to a `.part` file in `<root>/.bb-file-manager/uploads/` and
renames it into place only when the full byte count has arrived, so a partial
upload never appears as a real file in the destination folder.

Resuming works by re-dropping the same file into the same folder. A session is
keyed by destination directory, path inside a dropped folder, file name, size
and last-modified time; a matching session resumes from the byte count already
on disk instead of starting over. Chunks are retried three times with 1 s / 3 s
/ 9 s backoff, and each retry re-asks the server how many bytes it really has
before sending more.

Limits worth knowing:

| | |
| --- | --- |
| File size | No plugin-imposed limit — 1 GB and larger files are the design target. Free disk space is the real ceiling. |
| Chunk size | 4–64 MiB, from the `uploadChunkMiB` setting, then adapted within that range to keep a chunk near 45 s on your link. |
| Parallelism | 2 files at a time; chunks within a file are strictly sequential, and a second writer for the same session is rejected with `upload_busy`. |
| Session lifetime | 24 hours. A sweep runs at plugin load and hourly, deleting sessions whose part file is older than that. |
| Interruptions | Closing the panel keeps uploads running; closing the browser tab stops them. The staged bytes stay on disk, so re-dropping the same file continues where it stopped. |
| Failure modes | A chunk that would push the file past its declared size is rejected and rolled back to the last good offset; the file is never committed at the wrong length. |

Uploads survive navigation inside bb, and the sidebar row keeps a count of the
files still moving.

Listings are capped at 5000 entries per directory; larger folders are truncated
with a visible notice rather than freezing the panel.

## Security model

This plugin gives anyone who can reach your bb UI read and write access to
everything under the home folder. Treat installing it as equivalent to handing
out shell access to that directory tree.

Within that boundary:

- **One hard root.** `ROOT = realpath(homedir())` is resolved once at load.
  Every incoming path is normalized, resolved with `realpath` over its existing
  prefix, and rejected unless it is `ROOT` itself or starts with `ROOT + "/"`.
  Rejections raise `path_escape`. There is no setting that widens the root.
- **Symlinks are never followed out.** They are listed as `symlink` rows with
  the resolved target kind and an `escapesRoot` marker; a link pointing outside
  the root is not navigable, readable or writable through this plugin.
- **Names are validated, not sanitized.** `""`, `.`, `..`, anything containing
  `/` or a NUL byte, and over-long names are rejected as `invalid_name` before
  they reach the filesystem.
- **The upload route is token-gated.** `POST
  /api/v1/plugins/file-manager/http/upload/chunk` is registered with
  `auth: "token"` and requires the `x-bb-plugin-token` header, because it
  carries a raw binary body. The token comes from bb's own origin-gated token
  endpoint; `bb plugin token file-manager --rotate` invalidates it.
- **The download route uses bb's default local auth.** `GET
  /api/v1/plugins/file-manager/http/download?path=…` is restricted to the local
  browser session, because `<a download>` navigation sends no `Origin` header.
  Responses are `application/octet-stream` with `no-store, no-transform` and
  `X-Content-Type-Options: nosniff`.
- **Upload staging is contained.** In-flight parts live in
  `<root>/.bb-file-manager/uploads/`, and that directory is filtered out of
  every listing, including with hidden files shown.
- **Archive extraction is defensive.** Extractors run with
  `--no-same-owner --no-same-permissions` into a per-job staging directory;
  every extracted entry is re-checked for containment, and a member that would
  land outside the destination fails the whole job instead of being written. A
  job that fails halfway rolls back what it already moved, so a folder is never
  left half-extracted.
- **No network, no secrets.** The plugin makes no outbound requests and stores
  no credentials. It reads and writes the local filesystem under the root, and
  nothing else.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run build         # bb plugin build .
npm run check         # sdk pin + typecheck + tests + build

bb plugin install path:"$(git rev-parse --show-toplevel)" --plugin file-manager --yes
bb plugin reload file-manager
bb plugin logs file-manager --follow
```

`npm run dev` (`bb plugin dev .`) rebuilds the panel and reloads the plugin on
every save.

| Path | Contents |
| --- | --- |
| `server.ts` | backend entry: settings, RPC registration, HTTP routes, upload GC schedule |
| `src/` | path safety, listing, mutations, uploads, archives, jobs |
| `contract.ts` | the RPC contract shared by both sides; it is frozen and edited by nobody |
| `app.tsx`, `components/`, `hooks/`, `lib/` | the panel, the panel tabs and the settings section |
| `components/FileManagerTab.tsx`, `hooks/useFmLocation.ts`, `components/PanelActions.tsx` | the panel-tab surface: state-held location and the compact action cluster |
| `components/FileLocationOpener.tsx`, `src/locate.ts` | the two `fileOpener` slots and the path resolution behind them |
| `components/SettingsSection.tsx`, `lib/start-folder.ts` | the `settingsSection` slot and the start-folder logic it shares with the panel |
| `lib/fm-tree.ts`, `hooks/useTree.ts` | the folder tree: a pure reducer plus the lazy loader around it |
| `lib/fm-store.ts` | the two-tier client store (module scope over `localStorage`) both the expanded set and the location memory use |
| `lib/last-folder.ts` | what "reopen where I was" remembers, and the pure rule that picks the folder to open |
| `lib/fm-pathbar.ts`, `components/PathBar.tsx` | the path bar: what a pasted path means, and the strip that switches between crumbs and a text field |
| `components/ui/` | vendored bb UI kit (`npx shadcn add @bb/<name>`) — not hand-edited |
| `test/backend/`, `test/frontend/` | unit suites for each side |
| `test/integration/` | loads the real `server.ts` through bb's fake plugin host: contract coverage, route auth modes, upload / download / extract end to end |

`SPEC.md` and `TREE-SPEC.md` are the implementation specs the code is written
against.

## Releasing

This plugin is versioned by its own tag, `file-manager/vX.Y.Z`, cut from
`version` in `package.json` — which `PLUGIN_VERSION` in `server.ts` must match,
because that is the number the panel and the plugin's load line in the logs
report. The integration suite fails if the two drift. Tags are never moved; the
scheme and the range rules live in the [repository README](../../README.md).

The BB Community catalog entry is *not* kept in this directory. It lives as
`entries/file-manager.json` in
[get-bb/marketplace](https://github.com/get-bb/marketplace), filed as
[PR #90](https://github.com/get-bb/marketplace/pull/90), and that copy is the
source of truth — a draft next to the code only goes stale, as it did between
0.2.0 and 0.3.0. The entry resolves a source range against this repository's
tags, so any release inside that range reaches the catalog on its own — but
0.6.0 is outside the `^0.3.0` the open entry declares, so the range has to be
widened there before this release shows up in the catalog. Moving the source,
or changing the id, display name, description, tags or icon, needs a pull
request there too.

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Foma.
