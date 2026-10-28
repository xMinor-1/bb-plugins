# Doc Review

Read and comment on documents inside bb: Markdown, PDF, Word, PowerPoint,
Excel, and HTML open in a panel tab beside the chat, and a live site opened in
bb's browser takes comments right on its pages. Comment the way you would in Figma,
then hand every comment to an agent in one message — in the current chat or a
new one. The agent closes each comment with a note, so the tab shows what was
fixed and what still needs you, and you answer it right in the comment's
thread.

![A PDF report in Doc Review with its comment list: the agent asked a question, got an answer, reported back, and a new reply is being typed](../../media/doc-review/catalog-reply.png)

Version 0.2 absorbed the Document Viewer plugin (`pdf-viewer`): its Word,
PowerPoint, and Excel rendering and its classic PDF view live here now.

## What it opens

| Files | How they show |
| --- | --- |
| `.md`, `.markdown` | Rendered with bb's Markdown styles; comments map to source lines; `#section` links scroll to the heading, relative file links open from the document's folder |
| `.pdf` | Page by page, with a selectable text layer |
| Word: `docx`, `doc`, `odt`, `rtf` and templates | Converted to PDF by LibreOffice, then page by page |
| PowerPoint: `pptx`, `ppt`, `odp` and templates | Converted to PDF by LibreOffice, then slide by slide |
| Excel: `xlsx`, `xlsm`, `xls`, `xlsb`, `ods` and templates | A grid with sheet tabs, formatting, merged cells, frozen panes, zoom |
| `.html`, `.htm` | The live page in a sandboxed frame: its styles, pictures, and scripts next to the file load as usual |

Any matching file opened in bb — a link in a message, the file picker,
`bb thread open` — renders in a panel tab. A file attached to a chat message
is the exception: its chip opens bb's own preview, which plugins cannot take
over. For those, press the Doc Review button in the message's action bar, or
add a **Doc Review** tab to the chat's side panel: it lists the files attached
in the chat and opens the one you pick (straight away when there is only
one). Doc Review works on a copy kept in the chat's storage, in a `Doc
Review` folder, so the agent you send the comments to changes the file you
commented on; opening the attachment again opens the same copy. On pages, **Classic** switches to
the browser's own PDF viewer (search, print); the download button saves the
original file. Conversions are cached per file version, so a document
converts once and reopens at once.

## Reading pages

- **Zoom:** the bar in the corner (100% fits the width), Ctrl or Cmd with
  the scroll wheel, or a pinch on a trackpad or touch screen. The zoom stays
  anchored where you point, and pages re-render at the resolution it needs.
- **Wide pages:** every page shares one scale, so a landscape sheet, an A1
  drawing, or a wide chart is wider than the panel and scrolls sideways,
  while narrower pages stay centered. A page more than 2.5 times the typical
  width is scaled down to that.
- **Long documents:** only pages near the screen load their image and text.
  The page counter in the bar shows where you are; tap it to jump to a page.

## Commenting

![Select a line of Markdown, press Comment, type, and the comment lands in the list as a draft](../../media/doc-review/comment-text.gif)

- **Text:** select it and press **Comment**, right-click it, or press ⌘⌥M.
- **Area:** on pages and slides, switch to **Area** and draw a box around a
  chart or picture; the comment carries an image of that region.
- **Cells:** in a workbook, click a cell or drag over a range, then comment on
  it; commented cells show a mark in the corner.
- **Whole document:** one button at the top of the comment list.
- **HTML:** select text and comment as anywhere else, or switch to
  **Element** and click a block, button, or picture to comment on it; the
  agent gets the quote or the element's CSS path and the start of its HTML.
  Pages shown inside `<iframe srcdoc>` frames (a desktop and a phone preview
  side by side, say) take comments too, and the agent learns which frame.
- **Drawing:** on HTML pages and on pages and slides, switch to **Draw** and
  mark up the document the way you would on paper: the pen crosses out,
  underlines, or circles; the line draws a straight stroke from where you
  press to where you let go; the arrow shows where something should move; the
  box frames a block. Draw
  as many strokes as you need, then press **Comment** under them (the same
  bar clears the drawing and, from the second stroke on, takes back the last
  one; ⌘Z does too). The
  agent gets a picture of the drawing over the page as you saw it: on HTML
  that is the page in its current state (what you typed, opened, or
  scrolled), photographed by headless Chrome on the server; on pages, the
  page image under the strokes. On HTML the agent also learns what each
  stroke touches: the element a line lies on, the element inside a loop, and
  the elements at an arrow's tail and head, inside preview frames too.
- **On a touch screen:** select text with a long press; in **Area** mode hold,
  then drag to draw a box (a hold without a drag marks the spot); in **Draw**
  mode hold, then drag to draw; in a workbook tap a cell, or hold and drag
  over a range. A drag without the hold scrolls as usual.

![In Draw mode, circle a figure on a PDF page and comment on the drawing](../../media/doc-review/comment-drawing.gif)

The comments button in the toolbar hides the list beside the document for a
full-width view; the choice is remembered across files, and a click on a
comment's number on the page brings the list back.

Comments stay as drafts until you press **Send to chat** (this chat) or pick
**To a new chat** (same project, model, and workspace, fresh context). The
agent runs `bb doc-review resolve` or `bb doc-review reply`; the tab moves each
comment to *Done* or *Needs you* with the agent's note, live. The reviewed
file is never modified by the plugin; comments live in its own database.

## Threads

Each comment is a conversation. The agent's notes stay in it, one under
another, and **Reply** under the latest one answers back: confirm what it
understood, correct it, or reopen a comment it closed. A reply waits as a
draft with the comment (edit it with the pencil, drop it with ×) and goes
out with the other drafts on **Send**. The agent gets the comment, the
thread so far, and your new reply, and answers in the same thread, so the
exchange runs as long as it needs to, in this chat or a new one.

![Reply under the agent's question, and the answer waits as a draft with the comment](../../media/doc-review/reply.gif)

The **Doc Review** page in the sidebar lists files with comments and their
status, recent files, and a folder browser, and opens any file by path.

## Sharing comments as a PDF

The download button on a PDF, Word file, or presentation offers the
**Original file** or a **PDF with comments**: type the name to sign them
with and press **Download PDF**. In it:

- every comment is a PDF annotation (a highlight on quoted text, a box on
  an area, the strokes of a drawing, a note for the whole document) with the
  comment as its text and your name as its author, so PDF viewers list them
  as comments;
- each mark carries a numbered badge, and closing pages list every comment
  with its replies by number, for viewers that hide annotation text;
- the comments ride along as an attachment that Doc Review reads.

![Left: the download menu with PDF with comments and a name to sign with. Right: the exported page with a highlight, a drawing, a box and numbered badges](../../media/doc-review/catalog-export-pdf.png)

When someone with Doc Review opens that PDF in bb, a bar over it offers to
**Import** the comments: into the PDF, or into the file they were written on
(the deck or document) when it sits next to the PDF. Imported comments are
drafts under their author's name: change them, reply to them, add your own,
send them to an agent, or download a PDF with comments again to send back.
Importing that PDF on the first side adds the answers to the threads of the
original comments; importing a file twice adds nothing. In the panel, a PDF
that carries comments shows its pages without its own annotations and
without the closing list, so the comments do not show twice; **Classic**
shows the file as it is.

## Live sites

In the desktop app, a site opened in bb's browser (a stand, a staging server,
a running app) is reviewed on the page itself. Press **Review** beside the
address bar: a bar at the bottom of the page switches between **Text**
(select and comment; the page stays clickable), **Element** (click a block,
button, or picture), and **Draw** (pen and arrow, as on HTML files).
Numbered pins mark the comments, **Comments** opens the list for this page
with each thread and **Reply**, and **Send** hands every draft on the site to
the chat that owns the tab. A drawing goes with a screenshot of the tab, the
strokes on it; the controls step aside while the screenshot is taken and come
back as soon as the desktop app has it.

A site is one document: its comments live on, page by page, across reloads
and the agent's deploys, and each page shows the ones left on it. The Doc
Review page lists the site beside files, with every comment and thread. The
agent gets the site, each comment's page, and the quote or the element's
HTML, and is asked to change the code behind the page and ship it the way
the project does.

Only bb Desktop lets a plugin into its browser's pages: the web app and
phones show no Review button. A link to another page of the site keeps the
review on; after a full reload the controls come back within a few seconds.
The controls switch off when the tab is hidden behind another panel tab.

## Install

```sh
bb plugin install path:"/path/to/bb-plugins" --plugin doc-review --yes
```

bb opens a file with the first matching plugin in id order, so Doc Review is
the default for these formats unless you pin another viewer under
**Settings → File openers**. *Open with → Doc Review (view and comment)* is in
every file link's context menu.

## Requirements

On the machine the bb server runs on:

| Tool | Needed for |
| --- | --- |
| poppler-utils (`pdfinfo`, `pdftoppm`, `pdftotext`) | Pages, the text layer, area images |
| LibreOffice Writer / Impress | Word and PowerPoint files |
| LibreOffice Calc (optional) | Full formatting for legacy spreadsheets (`xls`, `xlsb`, `ods`); without it they open with values and fills |
| Chrome or Chromium (optional) | Pictures of drawings on HTML pages; without it the agent gets the elements the strokes touch |

| Platform | LibreOffice |
| --- | --- |
| Debian, Ubuntu | `sudo apt install libreoffice-writer libreoffice-impress libreoffice-calc` |
| Fedora | `sudo dnf install libreoffice-writer libreoffice-impress libreoffice-calc` |
| macOS | `brew install --cask libreoffice` |

Office documents often use Calibri and Cambria: on Linux,
`fonts-crosextra-carlito` and `fonts-crosextra-caladea` keep their layout.
Pages render with the fonts installed on the server, including `~/.fonts`.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Remember recently opened documents | on | Keeps the last 12 files opened from the Doc Review page in its Recent list |
| LibreOffice executable | empty | Full path to `soffice` when it is not on `PATH` or in the usual install folders |
| Chrome executable | empty | Full path to Chrome, Chromium, or Edge when it is not on `PATH` or in the usual install folders |

The name you sign exported comments with is remembered from the download
menu.

## For agents

The bundled skill (`skills/doc-review`) tells the agent how to apply a batch
and report back. The command:

```sh
bb doc-review list                          # comments sent to this thread, still waiting
bb doc-review list --status all --all-threads
bb doc-review show <id>                     # with its thread
bb doc-review resolve <id...> --note "what changed"
bb doc-review reply <id> --note "question or reason"
bb doc-review export deck.pptx --as "Name"  # writes "deck (comments).pdf" next to it
bb doc-review import "deck (comments).pdf" --into deck.pptx
```

## How it works

- `src/files.ts` resolves the opened path (workspace, thread storage, host
  path, or a project checkout) to an absolute path and host.
- `src/attachments.ts` serves the attachments tab (`ui/attachment-tab.tsx`,
  opened by the `review-attachments` message action or from the panel's tab
  list): it reads a thread's attached files from its message requests
  (`localFile` inputs) or from one message (`threads.message`), and copies
  the chosen one from the project's attachment store
  (`projects.attachments.read`) into the thread's storage under `Doc Review/`,
  never over another file, remembering the copy per attachment. The tab then
  shows the copy with the same view as any stored file.
- `src/viewer.ts` (from Document Viewer) converts Word and PowerPoint files
  with LibreOffice into a size- and age-bounded cache, copies files from other
  hosts, mints links for the classic view and downloads (bb's preview
  transport, or a ranged stream for large local files), and reads workbooks
  into grid models (`src/spreadsheet`).
- `src/render.ts` renders PDF pages to PNG with `pdftoppm` on first view, at
  a width from a fixed set of steps that the panel picks for its zoom and
  pixel density (within a 16-megapixel budget), three at a time with the
  newest request first. Word boxes come from `pdftotext -bbox-layout` for an
  invisible, selectable text layer.
- `ui/page-layout.ts` places pages at one scale and keeps the reading place
  across zooms and resizes; `ui/pages-doc.tsx` mounts only the pages near the
  viewport and fetches their images with cancellation, so flicking through a
  long document does not queue hundreds of renders.
- Markdown is split into top-level blocks (`marked` lexer) and rendered with
  bb's `Markdown` component, so a selection maps back to source lines.
  Highlights use the CSS Custom Highlight API.
- HTML pages are served by the plugin's `/html` route with a `<base>` pointing
  at bb's preview of the file's folder (so relative styles, pictures, and
  scripts load) and the bridge from `src/html-bridge.ts` first in the head, so
  it answers while a large page is still arriving. The page runs in a frame
  sandboxed without `allow-same-origin`, and the response carries the same
  sandbox as a CSP header, so its scripts cannot reach bb even when the URL is
  opened on its own. The bridge reports selections and picked elements to the
  panel with `postMessage` and paints the comments the panel sends back.
  Pages in `<iframe srcdoc>` frames get the bridge too (in the served markup,
  or when a script sets `srcdoc`); each bridge relays for its frames, adding
  the frame's CSS path to anchors and mapping rectangles through the frame's
  position and scale.
- Drawings (`src/drawing.ts` for the geometry): on pages the panel keeps the
  strokes as fractions of the page and makes the picture from the page image
  in a canvas. On HTML the bridge keeps them in page coordinates on its own
  overlay; for a comment it asks what lies under each stroke (frames answer
  for their part) and serializes the live page: form values, scroll
  positions, canvases, and the frames' current pages written in, scripts
  left out. `src/snapshot.ts` opens that in headless Chrome over its DevTools
  pipe with scripts disabled, lets files load only from the page's own
  folder, lays the strokes on top, and takes the screenshot. Pictures live
  next to the plugin's database and go to the agent as attachments.
- Live sites: the Review button (`ui/web-review.tsx`, a Browser toolbar
  action) installs the controls (`src/web-ui.ts`) and the bridge into the
  page's isolated world with `experimental_page.evaluate`. A Browser tab is
  a native view above the bb window, so the controls are drawn in the page,
  in a shadow root, rather than by the panel. The bridge talks to them
  through `window.__docReviewHost` instead of `postMessage`, leaves the
  page's frames alone, and sends no copy of the page; the controls ask the
  button for everything else over `bb.postMessage`, and the button answers
  through `__docReviewWeb.fromPlugin`. A drawing's picture is the tab's own
  screenshot (`web.capture`: the desktop browser instances on connected
  machines are asked for the tab, and the one that has it is remembered).
  The server keeps the JPEG and hands the panel a token that
  `comments.create` redeems, so the picture never travels back to the
  panel. A site is a `web`
  document keyed by its origin; each anchor carries the page URL, and pages
  match by path, without the query or hash.
- `src/store.ts` keeps documents, comments, and their threads (`replies`:
  the agent's notes and the user's answers, a draft answer last) in the
  plugin's SQLite database; every change publishes a realtime signal that
  open tabs follow. The tab also
  polls the file's version, so the agent's edits show up without reopening it.
- Exporting (`src/annotate.ts`, `src/exchange.ts`) loads the PDF the pages
  are shown from with `pdf-lib`, maps each anchor from fractions of the page
  as shown into the page's own coordinates through its rotation, and writes
  annotations with their own appearance streams (the badge is part of each),
  the list pages (in a system sans-serif font found with `fc-match`, for
  Cyrillic and other scripts), and the comments as JSON
  (`src/share.ts`) in an embedded file. Annotations are named
  `doc-review-<id>`, so exporting a PDF that came from an export first
  removes them, its list pages, and its attachment. A PDF that cannot be
  edited (encrypted or damaged) is rebuilt from its page images first.
  Opening a PDF looks for the attachment with `pdfdetach`; importing merges
  by the ids every comment and reply carries.
- Sending builds one message (file, then per comment: id, location, quote,
  request, and for a follow-up the thread and the new reply) and sends it to
  the current thread, or spawns a thread in the same
  project and environment with the source thread's model.

## Known limits

- Rendering runs on the bb server's machine; files on other hosts are copied
  there first (up to 64 MB).
- Page numbers in Word files come from LibreOffice's layout and can differ
  from Word's own.
- A PDF without its source can be commented on, but the agent can only answer
  those comments, not rebuild the PDF.
- In the classic view, comments are not shown; switch back with **Comment**.
  Phones have no usable built-in PDF viewer, so the button is hidden there.
- A text selection that spans two pages keeps the part on the first page.
- Comments go into exported PDFs from PDF, Word, and PowerPoint files only;
  Markdown, HTML, workbooks, and live sites are not exported. An imported
  comment edited on the other side comes back with its original text: only
  new replies and new comments travel back.
- Comments imported into a Word or PowerPoint file are placed by the other
  side's rendering of it; a different LibreOffice or fonts can shift them
  slightly.
- Relative file links in Markdown open only when the file belongs to a thread
  (its workspace or thread storage); a link to another file opens that file
  at its top, without jumping to its `#section`.
- HTML pages run with an opaque origin: `localStorage` is unavailable and a
  page's own `fetch` of files next to it is refused. A link that leaves the
  page shows a bar to return; comments work on the reviewed file only.
- Inside frames, comments work where the frame's page comes from `srcdoc`; a
  frame that loads another file or a site shows as is, without comments.
- bb's preview of the folder lasts an hour; an HTML page left open longer may
  fail to load pictures it had not loaded yet until it is reopened.
- Live sites need bb Desktop, and the browser APIs they use are experimental
  in bb's plugin SDK. Frames inside a live page take no comments, and a
  comment cannot be edited there (delete it and write it again, or edit it
  on the Doc Review page).

## Development

```sh
npm install
npm test           # vitest: formats, conversions, caches, workbook readers, anchors, exports
npm run typecheck
npm run build
npm run dev        # rebuild + reload on save
```

For local development, install this directory with `bb plugin install path:. --yes`
first. These commands work in PowerShell as well as Unix shells. If the bb
server runs on another machine, keep a checkout there and install that checkout's
path. Transfer committed changes with Git. To keep builds off the server, build
on the development machine, copy the generated `dist` directory into the server's
checkout, and run `bb plugin reload doc-review`. A watcher is optional and builds
on the machine where it runs.

### Local links in HTML reports

In Text mode, relative file links open in BB's preview panel on the report's
host. Links with `target="_blank"` keep the browser's native new-tab behavior,
using the document's preview URL to resolve relative paths. Paths are relative to the HTML
file: `other.html`, `../screens/example.png`, or `../../src/app.ts#L12`.
Spaces and percent-encoded names are supported; `:12:3` and `#L12C3` select a
line and column in code. Links to `#section` scroll inside the report.
External URLs and download links keep their ordinary browser behavior.

Comments sent to the current chat default to queued delivery: if the agent is busy,
the message waits until its current work finishes. If the chat is idle, it
starts immediately. The send dropdown also offers immediate delivery to direct
the agent's current work, or a new chat. The last used option is remembered in
this browser and shown on the main send button. Sending comments to a new chat starts that new chat.

The chat message shows the document name, comment count, requests and short
quotes. File paths, selectors, comment IDs and handling instructions are sent
in a separate `agent-only` text input. Copying the hand-off prompt still includes
the complete instructions.
Comment numbers always match their permanent document numbers, even when only
a subset is sent. New drawing images have a header with that number and the
document name, and uploaded filenames also carry the number.
The frontend adds readable comment numbers under Doc Review attachment thumbnails
in chat. This uses a disposable plugin content script; BB's image viewer and click
handlers stay unchanged. In the Doc Review panel, drawing previews open in a
dialog with the full image, a comment title and keyboard dismissal.

HTML drawing snapshots are captured by Chrome on the document's host, where
its local images and styles are available. The marked snapshot is attached as
a visible image in chat. A missing capture, unavailable Chrome or failed image
upload reports an error instead of silently sending a drawing without its image.

Selecting text in a user message (including sent comments) shows **Цитировать**
beside the selection. It inserts a Markdown quote into that thread's composer
without sending. Assistant messages keep BB's own selection menu. The plugin
adds no per-message action button and does not change BB core.

### Remote document performance

Version checks use file size and modification/change timestamps on the file's
own machine through the plugin's host entry. Native directory watches invalidate
cached versions; host disconnects, reconnects and worker exits clear the cache.
Watches expire after five minutes and are limited to 64 files. Checks do not read
or transfer the document body. The visible panel checks every four seconds, with at most one
request in flight; closed documents ignore late responses. Permission and
connection errors remain errors. HTML content is read once when its page is
served, including any embedded images. Files whose content and filesystem
metadata are deliberately restored to identical values cannot be distinguished
by this metadata check.

HTML opens directly from the URL returned by `doc.open`, without another
`doc.html` RPC. The server reuses up to two prepared document versions for
five minutes of inactivity and negotiates gzip for the response. Active entries
expire after 55 minutes, before their one-hour folder preview leases. Each open still checks
host connectivity and the watched version; a changed version gets a different URL and body.
Responses retain the HTML sandbox, `nosniff`, and `no-store`. The cache holds
immutable versions, not an offline copy of the latest file. A first open of a
remote file still depends on the host connection and transfer speed.
