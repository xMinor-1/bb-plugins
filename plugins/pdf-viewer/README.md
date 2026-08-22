# PDF Viewer

Read PDF files inside bb instead of downloading them.

- **Any `.pdf` opens in bb.** The plugin registers as a file opener for the
  `pdf` extension, so a PDF linked from a message, picked in the file picker,
  or opened with `bb thread open` renders in a panel tab — with the browser's
  own paging, zoom, search and print controls.
- **A PDF panel.** Browse a host's folders (only folders and PDFs are listed),
  open a document, and jump back to recent ones.
- **Large documents.** Below bb's 25 MB file-preview ceiling the plugin uses
  bb's native preview transport, which also reaches other connected hosts.
  Above it, documents on the server's own host stream from disk with HTTP range
  support, so a 100 MB scan opens without loading the whole file first.

## Install

```sh
bb plugin install path:"/path/to/bb-plugins" --plugin pdf-viewer --yes
```

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Remember recently opened documents | on | Keeps the last 12 documents in the panel's "Recent" list. Turn it off to record nothing. |

Settings changes apply immediately; the recent list can also be cleared from
the panel.

## How it works

- `server.ts` resolves a request to an absolute path and a host: workspace
  paths against the environment's checkout, thread-storage paths against the
  thread's storage root, host paths as-is.
- It then mints a URL for that one document. Preferred transport is
  `bb.sdk.files.createPreview`, confined to the document's own directory and
  leased for an hour. Documents past the preview ceiling are registered in an
  in-memory registry (`src/documents.ts`) and served by the plugin's own route
  (`src/http-routes.ts`), which honours `Range` and never accepts a path from
  the client — only an opaque, expiring id.
- `app.tsx` renders the URL in an iframe and re-mints it every 45 minutes so an
  open tab never hits an expired lease.

## Known limits

- A document larger than 25 MB **on another host** cannot be shown: bb's
  preview transport refuses it, and the streaming route only reads the server's
  own disk.
- The plugin's streaming route uses bb's `local` auth, which is what an iframe
  navigation from the bb app satisfies.

## Development

```sh
npm install
npm test           # vitest: range parsing, disposition headers, path helpers
npx tsc --noEmit
bb plugin build .
bb plugin dev .    # rebuild + reload on save
```
