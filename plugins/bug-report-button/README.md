# Bug Report Button

A **Bug report** item with a bug icon in the bb sidebar. It opens a page where people describe a problem and attach
screenshots, and the plugin sends the report: to a form as `multipart/form-data`, or to a tracker's REST API with the
person's own API key. Until sending is set up, the page links to the form in the browser instead.

## The page

- **Subject** (required) and **Description**.
- **Pictures**: drop them anywhere on the page, paste a screenshot from the clipboard, or choose files. Up to 6 PNG,
  JPEG, GIF or WebP pictures, 5 MB each and 15 MB together, with previews and a remove button on each. A file that does
  not fit is refused with a sentence that says why.
- **Send**: after a successful send the page shows the created record (a link when the form gives one) and clears
  itself. When sending fails, the error is shown in words and everything typed and attached stays.

## Settings

| Setting | Meaning |
| --- | --- |
| `formUrl` | The form in a browser. The page links to it, and only links to it while `submitUrl` is empty |
| `sendMode` | `form` (default) posts to `submitUrl`; `open` only opens `formUrl` in the browser; `rest`, see below |
| `label` | A heading on the page, for example in the people's own language. Empty shows nothing extra |
| `submitUrl` | Where the plugin posts the report as `multipart/form-data`. Empty turns sending off |
| `submitFields` | JSON object: form field name → text with `{subject}`, `{description}` and `{context}`. Empty: `{"subject":"{subject}","description":"{description}"}` |
| `fileField` | Form field name for the pictures (default `file`). Empty sends no pictures and hides them on the page |
| `fileMode` | `combine` (default) joins several pictures into one, for a form that takes a single file; `separate` sends each as its own file under the same field name |
| `recordUrl` | Address of a record with `{key}`, for a form that answers with a key such as `ABC-12` but no link |

### Open mode

With `sendMode` = `open` the bug only opens the form (`formUrl`) in the person's own browser, where they are signed in,
attach files and see the record the form creates. bb has no sidebar item that is a plain link, so the click opens the
plugin page and the page opens the form at once: in the desktop app through its "open in the external browser" bridge
(not bb's built-in browser, which has no session in the tracker), in the web app as a new tab. The page itself holds
one **Open the form** button and nothing else, for another go or for a browser that refused the new tab.

```sh
bb plugin config bug-report-button set sendMode open
bb plugin config bug-report-button set formUrl "https://forms.example.com/bugs/new"
```

### REST mode

With `sendMode` = `rest` the report goes to a tracker's API, signed with the person's own API key. Pictures go one of
three ways (`restFiles`):

- `form`: the report and its pictures in one `multipart/form-data` request to `submitPath`: the filled `submitFields`
  as text parts, the pictures under `fileField` (joined into one unless `fileMode` is `separate`).
- `attach` (default): the report as JSON to `submitPath`, then each picture to `attachPath` of the created record.
- `none`: the report as JSON only, for a form that takes no files through the API. Pictures can still be added on the
  page: it says beforehand that they stay, and after sending keeps them and links to `formUrl` to attach them there.

| Setting | Meaning |
| --- | --- |
| `apiBaseUrl` | The API address, such as `https://tracker.example.com/api/v1`. The key goes only there |
| `submitPath` | Path under it that takes the report, such as `/forms/<form id>/submit`. The body is `submitFields` filled in |
| `restFiles` | `form`, `attach` or `none`, see above |
| `attachPath` | Path that takes one picture of the created record, with `{key}`, such as `/issues/{key}/attachments`. Empty: no pictures |
| `attachField` | Field name of the picture in that request (default `file`) |
| `authHeader`, `authFormat` | How the key goes: header `X-API-Key` with `{key}` by default; `Authorization` with `Bearer {key}` also works |
| `shareKeyWith` | Another plugin whose key for the same API address is used when the person has not saved one here, such as `tracker-board` |
| `keyHelp` | One line next to the key field: where to get a key |

The person pastes their key on the page once. The plugin's host part, on their machine, keeps it in the OS key store
(macOS Keychain, Windows Credential Manager, elsewhere a 0600 file) under its own name, and sends it only to the origin
it was saved for. Redirects are not followed, so the key never goes to another address. With `shareKeyWith` the host
reads that plugin's key from the same store, only if that plugin saved it for the same address, and never changes or
deletes it. With `attach`, pictures are attached one by one after the record exists; if the tracker's answer names no record, or
a picture fails, the report stays sent and the page says which pictures did not make it.

`{context}` is the plugin version, the operating system and the app's user agent and window size: handy in a bug.

```sh
bb plugin config bug-report-button set submitUrl "https://forms.example.com/api/forms/123/submit"
bb plugin config bug-report-button set submitFields '{"title":"{subject}","body":"{description}\n\n{context}"}'
bb plugin config bug-report-button set fileField "attachment"
bb plugin config bug-report-button set recordUrl "https://tracker.example.com/{key}"
```

## How it works

- In the form mode the page hands the report to the plugin server over RPC, and the server posts it: a page in the app cannot post to
  another site because of CORS, and the server runs on the person's machine, so it reaches what they reach (VPN
  included). Nothing is sent anywhere else.
- `combine` stacks the pictures top to bottom in the page, on a canvas as wide as the widest picture (at most 1920 px);
  narrower ones keep their size. The result is PNG, or JPEG when PNG is over 5 MB.
- The record is read from the form's answer: a JSON field such as `key`, `issue_key` or `url` (also nested), or a key
  like `ABC-12` in the text.
- bb shows a new sidebar item to everyone who never changed the sidebar, and puts it under More for people who did.
  The item replaces a button that was always on screen, so on its first start the plugin adds it to their visible list,
  once. Hiding it afterwards sticks.

## Updating from 0.1

The floating button in the top bar is gone; the sidebar item appears by itself. `formUrl` and `label` keep working:
with no `submitUrl` the page links to the same form the button opened.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```
