# File Manager

A bb plugin that adds a full-page file manager for the machine that runs your
bb server. Browse, upload, download, move, rename and extract files under
`/home/coder` without leaving bb and without a shell.

Everything the panel touches lives under one hard root — `/home/coder` — and
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

The panel appears in the bb sidebar as **File Manager** and is routed at
`/plugins/file-manager/files/*`. While uploads are running, the sidebar row
shows how many are in flight.

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
| `Escape` | clear the selection (in the filter box, it clears the filter) |
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

## Requirements

- bb `>= 0.39` with `@get-bb/plugin-sdk >= 0.4.8` (Node 24).
- Archive extraction shells out to `tar`, `unzip` and `7z`/`7za`/`7zz`. Formats
  whose tool is missing are reported as unsupported instead of failing at
  extraction time; everything else works without them.

## Install

From the BB Community marketplace, once the entry is merged:

```bash
bb plugin install file-manager
bb plugin list --json | jq '.plugins[] | select(.id=="file-manager")'
```

Straight from git, which builds during install — the released tag, or the tip
of `main`:

```bash
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.2.0 \
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
| `startFolder` | string | `/home/coder` | Absolute path under the root the panel opens by default. Re-validated on every read; a deleted or out-of-root path falls back to the root. |
| `showHiddenFiles` | boolean | `false` | Show dot-files and dot-directories. |
| `confirmOnDelete` | boolean | `true` | Ask before deleting. |
| `sortField` | `name` \| `size` \| `modified` \| `kind` | `name` | Default sort column. |
| `sortDirection` | `asc` \| `desc` | `asc` | Default sort direction. |
| `uploadChunkMiB` | `4` \| `8` \| `16` \| `32` \| `64` | `16` | Upload chunk size. Larger chunks are faster on fast links; smaller chunks survive flaky ones. |

Toggles made in the panel are written back through the plugin's own
`savePreferences` method, so they persist without a reload.

## Uploads

Files are cut into chunks and sent one chunk per request. The server appends
each chunk to a `.part` file in `/home/coder/.bb-file-manager/uploads/` and
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
everything under `/home/coder`. Treat installing it as equivalent to handing
out shell access to that directory tree.

Within that boundary:

- **One hard root.** `ROOT = realpath("/home/coder")` is resolved once at load.
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
  `/home/coder/.bb-file-manager/uploads/`, and that directory is filtered out of
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
| `app.tsx`, `components/`, `hooks/`, `lib/` | the panel |
| `lib/fm-tree.ts`, `hooks/useTree.ts` | the folder tree: a pure reducer plus the lazy loader around it |
| `components/ui/` | vendored bb UI kit (`npx shadcn add @bb/<name>`) — not hand-edited |
| `test/backend/`, `test/frontend/` | unit suites for each side |
| `test/integration/` | loads the real `server.ts` through bb's fake plugin host: contract coverage, route auth modes, upload / download / extract end to end |

`SPEC.md` and `TREE-SPEC.md` are the implementation specs the code is written
against; `PUBLISHING.md` covers releasing and listing the plugin.

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Foma.
