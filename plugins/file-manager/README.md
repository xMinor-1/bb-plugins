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
- **Open a file to read it** — double-click (or `Enter`) hands the file to bb's
  own preview panel, so it opens as a tab beside the manager instead of
  landing in your downloads folder. A client with no preview panel downloads
  it as before, and an archive still opens the extract dialog.
- **Quick look** — `Space` on the selected row opens the same preview without
  taking your hands off the keyboard. It never downloads and never opens a
  folder, so holding `↓` and tapping `Space` is a way to skim a folder.
- **Gallery** — a grid of thumbnails instead of a list, for the folders where
  the file names are not the point. Images are shown, everything else keeps
  its type icon, and the choice is remembered.
- **Download** — streamed straight from disk with `Range` support, so a 10 GB
  file costs the browser no memory. It moved to the row menu, where it is a
  deliberate choice rather than the side effect of a double-click.
- **Jump to the thread's own folder** — one button in the panel tab opens the
  checkout the thread beside you is working in, instead of hunting for it.
- **Hand a file to the agent** — `@` in any composer lists files from this
  machine, and *Add to chat* in the row menu does the same from the panel. The
  file is read when the message is sent, so the agent never gets a stale copy.
- **Organize** — new folder, rename, delete, cut / copy / paste, drag to move.
  Batch operations report a result per path, and name collisions become
  `name (1).ext` instead of silently overwriting.
- **Extract archives** — `zip`, `tar`, `tar.gz`, `tar.bz2`, `tar.xz` and `7z`
  extract as cancellable background jobs, into a staging directory that is
  checked for containment before anything is committed.
- **Live refresh** — every mutation is published on a realtime channel, so a
  second open panel or a finishing background job updates the listing without
  polling.
- **Properties** — `Alt+Enter`, or **Properties** in either context menu,
  opens a panel of everything about a file or folder: size, times, permissions,
  owner, content type, and where a symlink really points. A folder's recursive
  size is one button away.
- **Hidden files** — dot-files toggle, remembered as a setting.
- **Type or paste a path** — the breadcrumbs turn into an address bar
  (`Ctrl`/`Cmd`+`L`, the pencil button, or a click on the empty space right of
  the last crumb). Paste a path to a **file** and the panel opens its folder
  with that file selected.
- **Reopens where you left off** — the folder you were last in comes back after
  you leave the panel, reload the page or restart bb. A setting turns it off.
- **Pick where it opens** — the plugin's settings page carries a folder
  browser for the start folder, so it is chosen rather than typed.
- **Bookmark the folders you live in** — a star in the toolbar and a list
  beside it, kept on the server, up to fifty. A folder that disappears is
  marked rather than deleted behind your back.

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
  sit at its right end; sort, the list/gallery switch, hidden files,
  collapse-all and refresh live in that menu instead of having their own
  buttons.
- **The filter folds into a magnifier**, so the path bar keeps a readable
  width. `Ctrl`/`Cmd`+`F` unfolds it; closing it clears the filter.

The folder you are in is kept by the tab itself rather than by the URL, so
navigating folders never takes the thread off screen, and the sidebar page and
a panel tab can stand in different folders at once. Both still share the
settings, the upload queue and the "reopen where I was" memory, because those
belong to the machine, not to a surface.

## One click to the thread's own folder

A panel tab opened beside a thread gets one button the other surfaces do not:
**Thread folder**, in the toolbar's action cluster. It takes you straight to
the checkout that thread is working in — the worktree the agent is editing —
without typing a path or walking down from your home folder.

It is only ever there when it can be used. bb runs plenty of threads that have
no folder to go to, and rather than a button that does nothing, the reason
moves into the overflow menu as a greyed-out line saying which of the three it
is:

- *this thread has no workspace* — the thread runs without an environment;
- *the workspace has no folder yet* — the environment has not been provisioned,
  or its worktree has already been removed;
- *outside your home folder* — the checkout is real, but this plugin never
  leaves your home folder, so it will not open it.

If the lookup itself fails — bb restarting, say — the button stays live and the
click retries; a second failure says so in a toast instead of doing nothing.

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
file still opens as a preview, plus one button.

What is claimed: text and docs, office files, config and data, code, web,
images, audio, video, archives and packages, fonts and binaries — 200-odd
extensions. Two things are outside it. `.pdf` is left to the pdf-viewer plugin,
because two plugins claiming one extension makes bb's automatic pick depend on
load order. And a name with no extension at all (`Makefile`, `LICENSE`,
`.env`) gets no *Open with* rows from any plugin — bb matches openers by
extension, so there is nothing for a plugin to claim.

To take an extension back, use **Settings → File openers** and pin *BB preview*
for it.

## Hand a file to the agent

The paperclip and the composer's **+** attach files from the machine your
browser runs on. This plugin adds the other machine — the one bb itself runs on
— in three places:

- **Type `@`** in any composer and start typing a name. Matches from your home
  folder appear under **Files**, with the folder they live in as the second
  line.
- **Right-click a row** in the file manager → **Add to chat**. Several files
  selected means several mentions, one per file.
- **+ → From File Manager…** opens a small browser over the composer, starting
  in your start folder. Double-click a file, or select it and press *Add to
  chat*.

All three insert the same thing: an **@-mention pill**, not a copy. The file is
read when you **send** the message, not when you pick it — so editing the file
after picking it sends the new version, and picking a file at the top of a long
draft still sends what is on disk at the end.

What the agent receives is the path, the size, the modification time, and the
content of text files up to 256 KB (longer files are cut off with a line saying
by how much). A binary file, a folder or an empty file arrives as the metadata
plus one sentence saying why there is no content. A file that was deleted
between picking and sending says so instead of blocking the message.

The same clamp applies as everywhere else: only files under the home folder of
the user running bb can be mentioned, symlinks that point outside it are not
offered, and the path is re-checked on the server when the message is sent.

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
| `Enter` | open: a folder navigates in, a file opens in bb's preview panel, an archive opens the extract dialog |
| `Space` | quick look: open the selected file in bb's preview panel. A folder does nothing — that is `Enter`'s job — and nothing is ever downloaded |
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

## Gallery

The button right of the filter swaps the list for a grid of thumbnails. Images
— `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `svg` — are shown as
themselves; everything else keeps the type icon it has in the list, with its
name underneath. In a side panel the switch lives in the overflow menu instead,
where the rest of the compact toolbar's controls are.

Everything you can do to a row you can do to a tile, because they are the same
handlers: click and `Ctrl`/`Shift`+click to select, right-click for the same
menu, double-click to open, drag onto a folder to move, drop files from your
desktop to upload. `Space` quick-looks the tile under the cursor, and `←` / `→`
walk to the previous and next one. The filter applies as it does in the list.

Two differences, both on purpose:

- **The gallery shows one folder.** Expanding a folder in place is a list
  affordance — a grid has nowhere to indent into — so tiles are always the
  contents of the folder you are in. Your expanded folders are not forgotten:
  switch back and the tree is as you left it.
- **There are no column headers to sort by**, so sorting moves to the toolbar's
  sort menu, which sorts the tiles exactly as it sorts the rows.

Thumbnails are streamed, never copied into the page: the panel asks bb for one
short-lived URL for the folder on screen and points each tile at a file under
it, so a folder of 300 photos costs one request plus whatever your browser
decides to fetch as you scroll — images load lazily. If your bb server is too
old to hand out such a URL, or an image will not decode, that tile quietly
falls back to its type icon; nothing else changes.

Which view you last used is remembered as the `viewMode` setting, so the panel
opens in it next time — including in a side panel, since both surfaces share
the plugin's settings.

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

## What exactly is this file?

**Properties**, from the right-click menu or `Alt+Enter`, answers it: name and
full path, kind, size, modified / created / accessed times, permissions in both
the `-rw-r--r--` and the `0644` form, owner, how many hard links point at it,
and the content type its extension implies. Right-click empty space and you get
the same panel for the folder you are standing in.

A symlink describes *itself* — its own permissions, its own times — and shows
where it points on a separate line. If it points outside your home folder, the
dialog says so and shows the raw target without resolving it: the panel is
never handed a path it is not allowed to open.

Folders keep their real size behind a **Calculate size** button, because
answering it means walking the whole subtree. The walk is bounded — it stops at
32 levels deep, at 200 000 entries, or after 5 seconds — and when a limit stops
it, the number is shown as a lower bound ("over 5 MB") with a line saying why,
rather than as a total that is quietly wrong. It never follows symlinks, so a
link pointing back at a parent cannot send it round forever. Close the dialog
and the answer is dropped.

Select several rows first and you get a summary instead: how many files, how
many folders, and the total size of the files. Folders are left out of that
total — each one would need its own walk.
## Bookmarks

One start folder is one folder. Most people work in several, so the toolbar
carries a **star**: it is lit when the folder on screen is bookmarked, and one
click adds it or takes it away. The chevron beside the star opens the list, and
one click on a row goes there.

| Where | What is there |
| --- | --- |
| toolbar star | add / remove the folder on screen; lit means bookmarked |
| the list beside it | every bookmark, in the order you added them; **Bookmark this folder** / **Remove bookmark** and **Rename this bookmark…** at the top |
| right-click on empty space | **Bookmark this folder** / **Remove bookmark**, next to *Set as start folder* |
| right-click on a folder row | **Bookmark** / **Remove bookmark** — folders only, one at a time |
| the panel-tab overflow (`⋯`) | the same list, because a ~450px column has no room for a second trigger |

A bookmark is a name and an absolute path. The name starts as the folder's own
and **Rename this bookmark…** changes it — the folder on disk is untouched, so
`~/Work/3. projects/x5transport` can be called *X5* without renaming anything.

Fifty is the ceiling. The star still answers past it and says what to do
instead of going grey.

If a bookmarked folder is deleted or moved, the row does not vanish: the list
shows it struck through and marked **Missing**, and choosing it removes the
bookmark. Nothing self-deletes behind you — an unmounted share comes back, a
list that quietly emptied itself does not. A bookmark that would now point
outside the root (the same bb data directory on a machine with a different home
folder) is dropped instead: it could never be opened from here.

The list lives on the server, in the plugin's own storage, so it is the same in
every browser and after a restart. That is deliberately different from *reopen
the last folder*, which is one browser profile's memory of a moment.

## Requirements

- bb `>= 0.40` with `@get-bb/plugin-sdk >= 0.4.21` (Node 24).
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
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.7.0 \
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
| `viewMode` | `list` \| `gallery` | `list` | Which view the panel opens in — the sortable table, or the thumbnail grid. |
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
| `src/properties.ts`, `components/dialogs/PropertiesDialog.tsx` | the Properties dialog: one lstat for a path, and the bounded recursive walk behind "Calculate size" |
| `lib/fm-tree.ts`, `hooks/useTree.ts` | the folder tree: a pure reducer plus the lazy loader around it |
| `components/FileGallery.tsx`, `lib/preview.ts`, `hooks/usePreviewBase.ts`, `src/preview.ts` | the gallery: the tile grid, what has a thumbnail, and the short-lived folder URL they stream from |
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
[get-bb/marketplace](https://github.com/get-bb/marketplace) — filed as
[PR #90](https://github.com/get-bb/marketplace/pull/90), widened to the 0.7.x
line in [PR #122](https://github.com/get-bb/marketplace/pull/122) — and that
copy is the source of truth; a draft next to the code only goes stale, as it
did between 0.2.0 and 0.3.0. The entry resolves a source range against this
repository's tags, so any release inside that range reaches the catalog on its
own. On a `0.x` line `^0.7.0` covers `0.7.x` only, so the next minor needs a
new pull request there — as do moving the source, or changing the id, display
name, description, tags or icon.

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Foma.
