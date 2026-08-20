# Publishing File Manager

Everything here is copy-pasteable and ordered. Nothing in this file has been
run: the plugin currently exists only as a path install from a bb workspace
directory, and no remote state has been changed.

Facts this file was written against (re-check anything that looks stale):

| | |
| --- | --- |
| Plugin id | `file-manager` (derived from `bb-plugin-file-manager`) |
| Version to release | `0.2.0` (`package.json#version` and `PLUGIN_VERSION` in `server.ts`) |
| GitHub account | `xMinor-1` (`gh auth status` already reports it as logged in) |
| Publishing home | `github.com/xMinor-1/bb-plugins`, directory `plugins/file-manager` |
| Release tag | `file-manager/v0.2.0` (the repo already tags this way: `theme-toggle/v0.2.1`) |
| Catalog entry draft | `marketplace-entry.json` in this directory → `entries/file-manager.json` in the fork |
| Working copy | `/home/coder/.bb/personal-workspaces/env_85kdqqyirz/bb-plugin-file-manager` |

## What blocks publication right now

1. **The code is not in any public repository.** It lives in a bb personal
   workspace, which is deleted together with its thread. `plugins/file-manager`
   in `xMinor-1/bb-plugins` still holds the 0.1.0 scaffold (8 files, backend
   stub only). Step 2 fixes this and is the only irreversible-if-skipped item.
2. **No release tag.** `git ls-remote --tags https://github.com/xMinor-1/bb-plugins.git 'refs/tags/file-manager/v*'`
   returns nothing today, so the marketplace liveness check (`npm run check`)
   would fail on the entry as drafted.
3. **Git identity.** `git config user.name` is `Dmitriy Fomin <640@ul.su>` and
   every existing commit in `bb-plugins` carries it, while this plugin's
   `LICENSE` says `Foma` and the catalog entry says `Foma`. Decide which name
   the public record should show (step 3) before the first push.
4. **The marketplace PR needs your explicit go-ahead.** Steps 7 and 8 change
   remote state (`git push`, `gh pr create`). Nothing before step 4 does.

Non-blocking, worth a decision:

- Your earlier submission (`get-bb/marketplace` PR #74, `theme-toggle`, still
  open) lists `"author": { "name": "Dmitriy Fomin" }` and a vendored icon file.
  This entry uses `"name": "Foma"` and the host icon name `FolderOpen`. Two
  entries from one GitHub account with two author names is legal but visible;
  see step 8 for the one-line icon swap and note 3 for the name.

## 1. Verify the account

```sh
gh auth status
gh api user --jq .login          # expect: xMinor-1
```

If the login is not `xMinor-1`, edit `marketplace-entry.json`: `author.github`,
`author.url` and `source.git.url` all name the account.

## 2. Move the code into the public repository

The workspace copy is the only complete copy. Move it first, verify second.

```sh
SRC="/home/coder/.bb/personal-workspaces/env_85kdqqyirz/bb-plugin-file-manager"
DST="/home/coder/Work/3. projects/BB Plugins/plugins/file-manager"

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  "$SRC"/ "$DST"/

cd "$DST"
npm install
npm run check     # sdk pin + tsc --noEmit + vitest + bb plugin build
```

`--delete` removes the old scaffold files that the new tree does not replace.
`.bb/plugins.json` in the repository root already registers
`file-manager → ./plugins/file-manager`, so nothing there needs editing.

Then update the two places that still describe the plugin as unbuilt:

- the root `README.md` table row for `file-manager` (status column), and
- the root `README.md` install block, which currently installs `file-manager`
  from `@main`; after the tag exists it can use
  `@^0.2.0 --plugin file-manager --tag-prefix file-manager/`.

Finally, delete the `_repository_todo` key from `plugins/file-manager/package.json`
once the code is pushed — `repository` itself is already correct for this home.

## 3. Decide the public author identity

The plugin's `LICENSE`, `package.json#author` and the catalog entry all say
`Foma`. Git commits do not. To keep new commits consistent, set a repo-local
identity before committing:

```sh
cd "/home/coder/Work/3. projects/BB Plugins"
git config user.name  "Foma"
git config user.email "273536422+xMinor-1@users.noreply.github.com"
git config --local --get-regexp '^user\.'
```

That address is GitHub's no-reply form for account `xMinor-1` (id 273536422),
so it links commits to the account without publishing a real mailbox. The global
git config is left untouched.

Two things this does **not** fix, decide consciously:

- Existing `bb-plugins` commits (all of them) are authored `Dmitriy Fomin
  <640@ul.su>` and are already public.
- The repository root `LICENSE` says `Copyright (c) 2026 Dmitriy Fomin`; this
  plugin's own `LICENSE` says `Foma`.

## 4. Commit

```sh
cd "/home/coder/Work/3. projects/BB Plugins"
git status --short
git add plugins/file-manager README.md
git commit -m "file-manager 0.2.0: full file manager panel with uploads, downloads and archives"
```

Check before committing that no build output slipped in:

```sh
git ls-files plugins/file-manager | grep -E '^plugins/file-manager/(dist|node_modules)/' || echo "clean"
```

## 5. Tag the release

```sh
git tag -a file-manager/v0.2.0 -m "Release file-manager v0.2.0"
git push origin main
git push origin file-manager/v0.2.0

git ls-remote --tags https://github.com/xMinor-1/bb-plugins.git 'refs/tags/file-manager/v*'
```

The last command must print the tag; the marketplace CI runs exactly it.
Never move or re-point a release tag afterwards — cut a new one instead.

Optional, if you want a GitHub Release page for it:

```sh
gh release create file-manager/v0.2.0 \
  --repo xMinor-1/bb-plugins \
  --title "File Manager 0.2.0" \
  --notes "First public release: browsing with in-place folder expansion, chunked resumable uploads, Range downloads, archive extraction as background jobs."
```

## 6. Install from the tag, exactly as the catalog will

This is the same resolution the catalog entry performs, so it proves the entry
before the PR. It replaces the current workspace path install.

```sh
bb plugin remove file-manager            # path install: the files stay put
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.2.0 \
  --plugin file-manager --tag-prefix file-manager/ --yes

bb plugin list | grep -A3 file-manager   # expect: file-manager@0.2.0 running
bb plugin logs file-manager -n 20
```

Open the panel once and upload a file, so the release is verified, not assumed.
To go back to live editing afterwards:

```sh
bb plugin remove file-manager
bb plugin install path:"/home/coder/Work/3. projects/BB Plugins" --plugin file-manager --yes
```

## 7. Prepare the marketplace fork

```sh
gh repo fork get-bb/marketplace --clone=false
git clone https://github.com/xMinor-1/marketplace.git /home/coder/Work/marketplace
cd /home/coder/Work/marketplace
git remote add upstream https://github.com/get-bb/marketplace.git   # skip if it exists
git fetch upstream main
git switch -c submit-file-manager upstream/main

cp "/home/coder/Work/3. projects/BB Plugins/plugins/file-manager/marketplace-entry.json" \
   entries/file-manager.json
```

The filename must equal the entry `id` — `entries/file-manager.json` — or the
build fails with `id must equal the filename`.

**Optional: ship the custom icon instead of the host icon name.** The entry as
drafted uses `"icon": "FolderOpen"`, which matches `bb.branding.icon` in the
manifest. To use `assets/icon.svg` instead (this is what your `theme-toggle`
entry does):

```sh
PLUGIN="/home/coder/Work/3. projects/BB Plugins/plugins/file-manager"
HASH=$(sha256sum "$PLUGIN/assets/icon.svg" | cut -c1-8)   # currently b3b5f8f4
cp "$PLUGIN/assets/icon.svg" "icons/file-manager-$HASH.svg"
echo "icons/file-manager-$HASH.svg"
```

then replace the icon line in `entries/file-manager.json` with:

```json
  "icon": { "url": "./icons/file-manager-b3b5f8f4.svg" },
```

using the hash the command printed. Remote icon URLs are rejected; the file must
be vendored in `icons/`.

## 8. Validate, commit, open the PR

```sh
cd /home/coder/Work/marketplace
npm ci --ignore-scripts
npm run build     # schema + id/filename + icon path
npm run check     # the above plus git ls-remote liveness on the tag

git status --short
git diff --check
git add entries/file-manager.json            # add icons/file-manager-*.svg too, if vendored
git commit -m "Add plugin entry: file-manager"
git push -u origin submit-file-manager
```

PR body:

```sh
cat > /tmp/fm-pr-body.md <<'MD'
## What it does

File Manager adds a full-page bb panel for the files on the machine that runs
the bb server: browsing with folders that expand in place, chunked resumable
uploads for multi-gigabyte files, Range-aware streamed downloads, rename /
move / copy / delete with per-path results, and archive extraction (zip, tar,
tar.gz, tar.bz2, tar.xz, 7z) as cancellable background jobs.

## Source

- `git`: https://github.com/xMinor-1/bb-plugins.git
- `subdir`: `plugins/file-manager`, `tagPrefix`: `file-manager/`
- `range`: `^0.2.0`, released as the annotated tag `file-manager/v0.2.0`

## Plugin checks

- `tsc --noEmit`: clean
- `vitest`: 485 tests across 24 files, all passing, including an integration
  suite that loads the real plugin factory against bb's fake plugin host
- `bb plugin build .`: emits `dist/server.js`, `dist/app.js`, `dist/app.css`
- `bb plugin types --check .`: SDK pin 0.4.8 matches the host
- installed from the tag with `bb plugin install git:...@^0.2.0 --plugin
  file-manager --tag-prefix file-manager/` and exercised in a live bb

## Marketplace checks

- `npm ci --ignore-scripts && npm run build && npm run check` pass in this fork

## Security facts for reviewers

- The plugin exposes the host filesystem under a single hard root,
  `realpath("/home/coder")`, resolved once at load. Every path is normalized and
  re-resolved, and anything that is not the root or under it is rejected.
  Symlinks that leave the root are listed but not readable, writable or
  navigable through the plugin.
- Two HTTP routes: the chunk-upload route is registered with `auth: "token"`
  (it carries a raw binary body), and the download route uses bb's default
  local auth because `<a download>` navigation sends no `Origin` header.
- Archive extraction runs `tar`/`unzip`/`7z` with `--no-same-owner
  --no-same-permissions` into a staging directory, re-checks every entry for
  containment, and rolls back a partially committed extraction.
- No outbound network requests and no stored credentials.
- Anyone who can reach the bb UI can read and write everything under
  `/home/coder` through the panel; the README states this explicitly.
MD

gh pr create \
  --repo get-bb/marketplace \
  --base main \
  --head xMinor-1:submit-file-manager \
  --title "Add plugin entry: file-manager" \
  --body-file /tmp/fm-pr-body.md
```

## 9. After the entry is merged

```sh
bb plugin search file-manager
bb plugin install file-manager          # or file-manager@bb-community
```

Add the PR link to the root `README.md` status column, the way the
`theme-toggle` row does.

## 10. Later releases

1. Bump `version` in `package.json` **and** `PLUGIN_VERSION` in `server.ts` —
   they are kept in sync by hand, and the panel shows the second one.
2. `npm run check`.
3. Commit, then `git tag -a file-manager/v0.2.1 -m "Release file-manager v0.2.1"`
   and push the tag.

A new tag inside the published range (`^0.2.0` means `>=0.2.0 <0.3.0`) needs no
marketplace PR — `bb plugin outdated` picks it up on the next catalog refresh.
A `0.3.0` release, or any change to the source location, id, display name,
description, tags, icon or ownership, needs a new pull request against
`get-bb/marketplace`.
