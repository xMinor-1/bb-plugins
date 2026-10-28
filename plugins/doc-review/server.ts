// bb-plugin-doc-review — backend entry.
//
// View and comment on Markdown, PDF, Word, PowerPoint, Excel, and HTML files
// in a panel tab, then hand the comments to an agent in one message. Viewing
// (LibreOffice conversions, workbooks, links for the classic PDF view) lives
// in src/viewer.ts; page images and text boxes in src/render.ts; HTML pages
// are served into a sandboxed frame with the bridge from src/html-bridge.ts.
// Comments live
// in this plugin's SQLite database; the reviewed file is never modified by
// the plugin. Agents report back with the `bb doc-review` command, and every
// change reaches open panels through a realtime signal.
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { LeaseCache } from "./src/lease-cache.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isSupportedPath } from "./lib/formats.js";
import { rpcContract, type Capture, type RecentDocument } from "./src/contract.js";
import { reviewCli } from "./src/cli.js";
import { createAttachments } from "./src/attachments.js";
import { createExchange } from "./src/exchange.js";
import { DocFiles } from "./src/files.js";
import { BRIDGE_SCRIPT, HTML_SANDBOX, injectIntoHtml } from "./src/html-bridge.js";
import { buildHandoffInput, buildHandoffMessage } from "./src/message.js";
import { Renderer, renderWidth, type PageSize } from "./src/render.js";
import { findChrome, PageCamera } from "./src/snapshot.js";
import { MIGRATIONS, ReviewStore, type Db, type DocRow } from "./src/store.js";
import {
  docKindFor,
  draftReply,
  HTML_EXTENSIONS,
  isDrawing,
  isPaged,
  MARKDOWN_EXTENSIONS,
  sharedWithOthers,
  type ReviewComment,
  type ReviewDoc,
} from "./src/types.js";
import {
  createViewer,
  normalizeLocale,
  serverPlatform,
  type Located,
  type MissingLibreOffice,
} from "./src/viewer.js";

export { rpcContract };
export type { RpcContract } from "./src/contract.js";

/** Realtime channel the panel listens on; payload `{ docIds }`. */
const CHANGED = "review-changed";
const PAGE_ROUTE = "/page";
const HTML_ROUTE = "/html";
const DRAWING_ROUTE = "/drawing";
const gzipAsync = promisify(gzip);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
/** Screenshots of live pages wait this long for their drawing comment. */
const SHOT_KEEP_MS = 10 * 60 * 1000;
const SHOTS_MAX = 8;
/** The largest HTML page served into the review frame. */
const HTML_MAX_BYTES = 20 * 1024 * 1024;
const NO_PROJECT =
  "This file is not in a project, so a new chat cannot be started from here.";
const RECENTS_KEY = "recent-documents";
/** The name exported comments are signed with, as last used. */
const SIGNER_KEY = "export-signer";
const RECENTS_LIMIT = 12;

/** Thrown where pages are needed but LibreOffice cannot make them. */
class NeedsLibreOfficeError extends Error {
  constructor(readonly missing: MissingLibreOffice) {
    super(
      missing.installed
        ? `LibreOffice ${missing.component === "impress" ? "Impress" : "Writer"} is needed to show this file.`
        : "LibreOffice is needed to show this file.",
    );
  }
}

/** Comments on a live site are not tied to a version of anything. */
const WEB_VERSION = "live";

/** Pictures are PNG, except screenshots of live pages, which stay the browser's JPEG. */
function imageType(bytes: Buffer): { ext: "png" | "jpg"; mime: string } | null {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { ext: "png", mime: "image/png" };
  if (bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) return { ext: "jpg", mime: "image/jpeg" };
  return null;
}

/** The origin a page belongs to: a site is one document. */
function siteOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not a web address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Doc Review comments on http and https pages.");
  }
  return parsed.origin;
}

function docName(doc: DocRow): string {
  return doc.kind === "web" ? doc.absPath.replace(/^https?:\/\//, "") : path.posix.basename(doc.absPath);
}

export default async function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, MIGRATIONS);
  const store = new ReviewStore(database as unknown as Db);
  const dataDir = path.dirname(database.name);
  const files = new DocFiles(bb, dataDir);
  const htmlPages = new LeaseCache<{
    body: Buffer; compressed: Buffer; contentType: string; close(): void;
  }>({ maxEntries: 2, idleMs: 5 * 60 * 1000, maxAgeMs: 55 * 60 * 1000 });
  bb.onDispose(() => htmlPages.clear());
  const renderer = new Renderer(dataDir);

  const settings = bb.settings.define({
    rememberRecents: {
      type: "boolean",
      label: "Remember recently opened documents",
      default: true,
    },
    libreOfficePath: {
      type: "string",
      label: "LibreOffice executable",
      description:
        "Word and PowerPoint files are converted with LibreOffice on the machine bb runs on. Leave empty to find it automatically; set the full path to soffice if it lives somewhere unusual.",
      default: "",
    },
    chromePath: {
      type: "string",
      label: "Chrome executable",
      description:
        "A drawing on an HTML page reaches the agent as a picture of the page taken by headless Chrome or Chromium on the machine bb runs on. Leave empty to find it automatically; without it the agent gets the elements the drawing touches.",
      default: "",
    },
  });
  const camera = new PageCamera(
    async () => findChrome((await settings.get()).chromePath),
    path.join(dataDir, "shots"),
  );
  const drawingsDir = path.join(dataDir, "drawings");
  const drawingFiles = (id: string) => [path.join(drawingsDir, `${id}.png`), path.join(drawingsDir, `${id}.jpg`)];
  const drawingFile = (id: string) => drawingFiles(id).find((file) => existsSync(file)) ?? null;

  // Screenshots of live pages, kept here from `web.capture` until the drawing
  // comment they were taken for is saved: the panel only holds a token.
  const shots = new Map<string, { bytes: Buffer; at: number }>();
  function keepShot(bytes: Buffer): string {
    const now = Date.now();
    for (const [token, shot] of shots) if (now - shot.at > SHOT_KEEP_MS) shots.delete(token);
    for (const token of shots.keys()) {
      if (shots.size < SHOTS_MAX) break;
      shots.delete(token);
    }
    const token = randomUUID();
    shots.set(token, { bytes, at: now });
    return token;
  }
  /** Which desktop app holds a Browser tab, remembered so the next screenshot skips the search. */
  const tabPlaces = new Map<string, { hostId: string; instanceId: string; generation: string }>();

  /** A comment as the panel gets it: drawings with a picture carry its URL. */
  function present(comment: ReviewComment): ReviewComment {
    if (!isDrawing(comment.anchor) || !drawingFile(comment.id)) return comment;
    return { ...comment, imageUrl: `/api/v1/plugins/${bb.pluginId}/http${DRAWING_ROUTE}?c=${comment.id}` };
  }

  /** Capture a new drawing with its permanent document comment number. */
  async function saveDrawing(doc: DocRow, comment: ReviewComment, capture: Capture): Promise<void> {
    const anchor = comment.anchor;
    let bytes: Buffer | null = null;
    const label = `Комментарий №${comment.seq} · ${path.posix.basename(doc.absPath.replace(/\\/g, "/"))}`.slice(0, 200);
    const photograph = (shot: import("./src/snapshot.js").PageShot) => doc.hostId === null ? camera.shoot(shot) : files.drawing(doc, shot);
    if (capture.kind === "png") {
      const data = Buffer.from(capture.data.replace(/^data:image\/png;base64,/, ""), "base64");
      if (!data.subarray(0, 8).equals(PNG_SIGNATURE) || data.length < 24) throw new Error("Expected a PNG drawing capture.");
      const w = data.readUInt32BE(16), h = data.readUInt32BE(20);
      if (w < 1 || h < 1 || w > 20000 || h > 20000 || w * h > 16_000_000) throw new Error("The drawing image is too large.");
      bytes = await photograph({ label, folder: path.posix.dirname(doc.absPath.replace(/\\/g, "/")),
        html: `<html><body style="margin:0"><img style="display:block" src="data:image/png;base64,${data.toString("base64")}"></body></html>`,
        viewport: { w, h }, scroll: { x: 0, y: 0 }, strokes: [],
      });
    } else if (capture.kind === "shot") {
      bytes = shots.get(capture.token)?.bytes ?? null;
      shots.delete(capture.token);
    } else if (anchor.kind === "html-drawing" && doc.kind === "html") {
      const shot = {
        label,
        html: capture.html,
        folder: path.posix.dirname(doc.absPath.replace(/\\/g, "/")),
        viewport: anchor.viewport,
        scroll: capture.scroll,
        strokes: anchor.strokes,
      };
      bytes = await photograph(shot);
    }
    if (!bytes) throw new Error("Could not capture the drawing; Chrome must be available on the document's host.");
    const type = imageType(bytes);
    if (!type) throw new Error("Unsupported drawing image format.");
    await mkdir(drawingsDir, { recursive: true });
    await writeFile(path.join(drawingsDir, `${comment.id}.${type.ext}`), bytes);
  }
  const viewer = createViewer(bb, {
    dataDir,
    localHostId: () => files.localHostId(),
    libreOfficePath: async () => (await settings.get()).libreOfficePath,
  });

  function located(doc: DocRow): Located {
    return { absPath: doc.absPath, hostId: doc.hostId };
  }

  function publish(docIds: string[]): void {
    if (docIds.length > 0) bb.realtime.publish(CHANGED, { docIds });
  }

  function requireDoc(docId: string): DocRow {
    const doc = store.getDoc(docId);
    if (!doc) throw new Error("This document is no longer known; reopen the file.");
    return doc;
  }

  async function currentVersion(doc: DocRow): Promise<string> {
    // A live site has no file to version; its pages are whatever the server sends.
    if (doc.kind === "web") return WEB_VERSION;
    const version = await files.version(doc);
    if (version === null) throw new Error(`The file is gone: ${doc.absPath}`);
    return version;
  }

  function toDto(doc: DocRow, version: string): ReviewDoc {
    return {
      id: doc.id,
      kind: doc.kind,
      name: docName(doc),
      absPath: doc.absPath,
      hostId: doc.hostId,
      version,
      htmlUrl: doc.kind === "html" ? `/api/v1/plugins/${bb.pluginId}/http${HTML_ROUTE}?doc=${doc.id}&v=${encodeURIComponent(version)}` : null,
    };
  }

  /** The PDF whose pages are shown: the file itself, or LibreOffice's rendering of it. */
  async function pdfFor(doc: DocRow): Promise<string> {
    if (!isPaged(doc.kind)) throw new Error("This kind of document has no pages.");
    const file = await viewer.localFile(located(doc));
    if (doc.kind === "pdf") return file.path;
    const converted = await viewer.convertedPdf(file, path.posix.basename(doc.absPath), doc.kind);
    if (typeof converted !== "string") throw new NeedsLibreOfficeError(converted);
    return converted;
  }

  const exchange = createExchange({
    store,
    files,
    renderer,
    dataDir,
    pdfFor,
    currentVersion,
    log: (message) => bb.log.warn(message),
  });
  const attachments = createAttachments({ bb, files });

  async function readSigner(): Promise<string | null> {
    return (await bb.storage.kv.get<string>(SIGNER_KEY)) || null;
  }

  async function readRecents(): Promise<RecentDocument[]> {
    return (await bb.storage.kv.get<RecentDocument[]>(RECENTS_KEY)) ?? [];
  }

  async function rememberDocument(doc: DocRow): Promise<void> {
    if (!(await settings.get()).rememberRecents) return;
    const hostId = doc.hostId;
    const next = [
      { path: doc.absPath, name: path.posix.basename(doc.absPath), hostId, openedAtMs: Date.now() },
      ...(await readRecents()).filter((entry) => entry.path !== doc.absPath || entry.hostId !== hostId),
    ].slice(0, RECENTS_LIMIT);
    await bb.storage.kv.set(RECENTS_KEY, next);
  }

  /** The host the Doc Review page browses when the user has not picked one. */
  async function defaultHostId(): Promise<string> {
    const local = await files.localHostId();
    if (local) return local;
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((candidate) => candidate.status === "connected") ?? hosts[0];
    if (!host) throw new Error("No host is available to browse.");
    return host.id;
  }

  bb.http.route("GET", PAGE_ROUTE, async (context) => {
    const docId = context.req.query("doc") ?? "";
    const wanted = context.req.query("v") ?? "";
    const n = Number.parseInt(context.req.query("n") ?? "", 10);
    const requested = Number.parseInt(context.req.query("w") ?? "", 10);
    const doc = store.getDoc(docId);
    if (!doc || !isPaged(doc.kind) || !Number.isInteger(n) || n < 1) {
      return context.text("Not found", 404);
    }
    try {
      const version = await currentVersion(doc);
      // A stale URL means the file changed: the panel refetches its page list.
      if (version !== wanted) return context.text("Stale page", 404);
      const pdf = await pdfFor(doc);
      const size = (await renderer.pageSizes(doc.id, version, pdf))[n - 1];
      if (!size) return context.text("Not found", 404);
      const width = renderWidth(size, Number.isFinite(requested) ? requested : null);
      // A PDF exported with comments shows them as Doc Review's own, not twice.
      const clean = (await exchange.sharedIn(doc)) !== null;
      const image = await renderer.pageImage(doc.id, version, pdf, n, width, clean);
      const bytes = await readFile(image);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": "image/png",
          "cache-control": "private, max-age=86400, immutable",
        },
      });
    } catch (error) {
      bb.log.warn(`page ${n} of ${doc.absPath}: ${String(error)}`);
      return context.text("Render failed", 500);
    }
  });

  // An HTML page for the review frame: the file with a <base> next to it and
  // the bridge script. The CSP sandbox keeps the page's scripts away from bb
  // even if this URL is opened on its own.
  bb.http.route("GET", HTML_ROUTE, async (context) => {
    const docId = context.req.query("doc") ?? "";
    const wanted = context.req.query("v") ?? "";
    const doc = store.getDoc(docId);
    if (!doc || doc.kind !== "html") return context.text("Not found", 404);
    try {
      // Cached bytes are an immutable document version. Polling opens the new version.
      const key = JSON.stringify([doc.id, wanted]);
      return await htmlPages.use(key, async () => {
        const version = await currentVersion(doc);
        if (version !== wanted) throw new Error("This page changed; reload it.");
        const [source, baseUrl] = await Promise.all([
          files.readBytes(doc, HTML_MAX_BYTES), files.assetBaseUrl(doc),
        ]);
        const page = injectIntoHtml(source, {
          baseHref: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/` : null,
          script: BRIDGE_SCRIPT,
        });
        return { ...page, compressed: await gzipAsync(page.body), close() {} };
      }, async (page) => {
        const compressed = (context.req.header("accept-encoding") ?? "").split(",").some((entry) => {
          const [coding, ...parameters] = entry.trim().toLowerCase().split(";");
          const quality = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
          return coding === "gzip" && (!quality || Number(quality.slice(2)) > 0);
        });
        return new Response(new Uint8Array(compressed ? page.compressed : page.body), {
          headers: {
            "content-type": page.contentType,
            "content-security-policy": `sandbox ${HTML_SANDBOX}`,
            "cache-control": "no-store",
            "vary": "Accept-Encoding",
            ...(compressed ? { "content-encoding": "gzip" } : {}),
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        });
      });
    } catch (error) {
      bb.log.warn(`html page ${doc.absPath}: ${String(error)}`);
      return context.text("Could not open this page.", 500);
    }
  });

  bb.http.route("GET", DRAWING_ROUTE, async (context) => {
    const id = context.req.query("c") ?? "";
    if (!/^c_[a-z0-9]+$/.test(id)) return context.text("Not found", 404);
    const file = drawingFile(id);
    const bytes = file ? await readFile(file).catch(() => null) : null;
    const type = bytes ? imageType(bytes) : null;
    if (!bytes || !type) return context.text("Not found", 404);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": type.mime, "cache-control": "private, max-age=86400, immutable" },
    });
  });

  /** Pictures for comments: crops of area comments on pages, and the pictures drawings came with. */
  async function commentImages(
    doc: DocRow,
    comments: ReviewComment[],
  ): Promise<Map<string, Buffer>> {
    const images = new Map<string, Buffer>();
    const areas = comments.filter((comment) => comment.anchor.kind === "page-area");
    if (areas.length > 0 && isPaged(doc.kind)) {
      const version = await currentVersion(doc);
      const pdf = await pdfFor(doc);
      const sizes = await renderer.pageSizes(doc.id, version, pdf);
      for (const comment of areas) {
        const anchor = comment.anchor;
        if (anchor.kind !== "page-area") continue;
        const size: PageSize | undefined = sizes[anchor.page - 1];
        if (!size) continue;
        try {
          images.set(comment.id, await renderer.crop(pdf, anchor.page, size, anchor.rect));
        } catch (error) {
          bb.log.warn(`crop for ${comment.id}: ${String(error)}`);
        }
      }
    }
    for (const comment of comments) {
      if (!isDrawing(comment.anchor)) continue;
      const file = drawingFile(comment.id);
      const bytes = file ? await readFile(file).catch(() => null) : null;
      if (!bytes) throw new Error("This drawing has no captured image. Recreate the drawing before sending it.");
      images.set(comment.id, bytes);
    }
    return images;
  }

  /** Saves crops next to the plugin data so an agent can open them by path. */
  async function saveCrops(images: Map<string, Buffer>): Promise<Map<string, string>> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = path.join(dataDir, "crops");
    await mkdir(dir, { recursive: true });
    const paths = new Map<string, string>();
    for (const [id, bytes] of images) {
      const file = path.join(dir, `${id}.${imageType(bytes)?.ext ?? "png"}`);
      await writeFile(file, bytes);
      paths.set(id, file);
    }
    return paths;
  }

  function pickComments(docId: string, ids: string[] | undefined): ReviewComment[] {
    const all = store.listComments(docId);
    const chosen = ids
      ? all.filter((comment) => ids.includes(comment.id))
      : all.filter((comment) => comment.status === "draft");
    if (chosen.length === 0) throw new Error("There are no draft comments to send.");
    return chosen;
  }

  bb.rpc.register(rpcContract, {
    async "doc.open"({ path: rawPath, source, remember }) {
      const kind = docKindFor(rawPath);
      if (!kind) {
        throw new Error("Doc Review opens Markdown, PDF, Word, PowerPoint, Excel, and HTML files.");
      }
      const { absPath, hostId } = await files.resolve(rawPath, source);
      const doc = store.upsertDoc(hostId, absPath, kind);
      const dto = toDto(doc, await currentVersion(doc));
      if (remember) await rememberDocument(doc);
      return { doc: dto };
    },

    async "doc.get"({ docId }) {
      const doc = requireDoc(docId);
      return { doc: toDto(doc, await currentVersion(doc)) };
    },

    async "docs.list"() {
      return {
        docs: store.listDocsWithCounts(100).map((doc) => ({
          id: doc.id,
          kind: doc.kind,
          name: docName(doc),
          absPath: doc.absPath,
          hostId: doc.hostId,
          counts: doc.counts,
          lastActivity: doc.lastActivity,
        })),
      };
    },

    async "doc.version"({ docId }) {
      const doc = requireDoc(docId);
      return { version: doc.kind === "web" ? WEB_VERSION : await files.version(doc) };
    },

    async "web.capture"({ threadId, tabId }) {
      // The toolbar knows its thread and tab; the desktop app holding the
      // tab is found by asking each connected machine's browser instances.
      const browsers = bb.sdk.experimental_desktopBrowsers;
      const key = `${threadId}\n${tabId}`;
      const take = async (place: { hostId: string; instanceId: string; generation: string }) => {
        const shot = await browsers.captureTab({ ...place, threadId, tabId });
        return { token: keepShot(Buffer.from(shot.base64, "base64")) };
      };
      const known = tabPlaces.get(key);
      if (known) {
        try {
          return await take(known);
        } catch {
          tabPlaces.delete(key);
        }
      }
      const hosts = (await bb.sdk.hosts.list()).filter((host) => host.status === "connected");
      for (const host of hosts) {
        const listed = await browsers.listInstances({ hostId: host.id }).catch(() => null);
        for (const instance of listed?.instances ?? []) {
          const place = { hostId: host.id, instanceId: instance.instanceId, generation: instance.generation };
          try {
            const result = await take(place);
            if (tabPlaces.size >= 200) tabPlaces.clear();
            tabPlaces.set(key, place);
            return result;
          } catch {
            // Another instance holds the tab.
          }
        }
      }
      throw new Error("No desktop browser has this tab.");
    },

    async "attachments.list"({ threadId, seq }) {
      return { files: await attachments.list(threadId, seq) };
    },

    async "attachments.open"({ threadId, path: stored, name }) {
      return { path: await attachments.copy(threadId, { path: stored, name }) };
    },

    async "web.open"({ url }) {
      const doc = store.upsertDoc(null, siteOf(url), "web");
      return { doc: toDto(doc, WEB_VERSION) };
    },

    async "doc.markdown"({ docId }) {
      const doc = requireDoc(docId);
      if (doc.kind !== "md") throw new Error("Not a Markdown file.");
      const version = await currentVersion(doc);
      const [content, assetBaseUrl] = await Promise.all([
        files.readText(doc),
        files.assetBaseUrl(doc),
      ]);
      return { version, content, assetBaseUrl };
    },

    async "doc.html"({ docId }) {
      const doc = requireDoc(docId);
      if (doc.kind !== "html") throw new Error("Not an HTML file.");
      const version = await currentVersion(doc);
      const v = encodeURIComponent(version);
      return { version, url: `/api/v1/plugins/${bb.pluginId}/http${HTML_ROUTE}?doc=${doc.id}&v=${v}` };
    },

    async "doc.pages"({ docId }) {
      const doc = requireDoc(docId);
      const version = await currentVersion(doc);
      let pdf: string;
      try {
        pdf = await pdfFor(doc);
      } catch (error) {
        if (error instanceof NeedsLibreOfficeError) {
          return { status: "needs-libreoffice" as const, ...error.missing, platform: serverPlatform() };
        }
        throw error;
      }
      // A PDF exported with comments: its closing list pages repeat what the panel shows.
      const shared = await exchange.sharedIn(doc);
      const sizes = (await renderer.pageSizes(doc.id, version, pdf)).slice(0, shared?.file.pages);
      const base = `/api/v1/plugins/${bb.pluginId}/http${PAGE_ROUTE}`;
      const v = encodeURIComponent(version);
      return {
        status: "ready" as const,
        version,
        pages: sizes.map((size, index) => ({
          n: index + 1,
          width: size.width,
          height: size.height,
          url: `${base}?doc=${doc.id}&v=${v}&n=${index + 1}`,
        })),
      };
    },

    async "doc.pageText"({ docId, version, n }) {
      const doc = requireDoc(docId);
      const current = await currentVersion(doc);
      if (current !== version) throw new Error("The file changed; reload it.");
      const pdf = await pdfFor(doc);
      const page = await renderer.pageText(doc.id, current, pdf, n);
      return { n, lines: page.lines };
    },

    async "doc.links"({ docId }) {
      const doc = requireDoc(docId);
      const download = await viewer.mintLink(located(doc));
      if (doc.kind === "pdf") return { document: download, download };
      if (doc.kind === "text" || doc.kind === "presentation") {
        try {
          return { document: await viewer.mintLink({ absPath: await pdfFor(doc), hostId: null }), download };
        } catch (error) {
          if (error instanceof NeedsLibreOfficeError) return { document: null, download };
          throw error;
        }
      }
      return { document: null, download };
    },

    async "sheet.open"({ docId, locale }) {
      const doc = requireDoc(docId);
      if (doc.kind !== "spreadsheet") throw new Error("Not a spreadsheet.");
      const version = await currentVersion(doc);
      return await viewer.withWorkbook(located(doc), normalizeLocale(locale), async (reader) => ({
        version,
        workbook: reader.summary,
        sheet: await reader.readSheet(reader.summary.activeSheet),
        fidelity: reader.fidelity,
      }));
    },

    async "sheet.read"({ docId, index, locale }) {
      const doc = requireDoc(docId);
      return await viewer.withWorkbook(located(doc), normalizeLocale(locale), async (reader) => {
        if (index >= reader.summary.sheets.length) throw new Error("This workbook has no such sheet.");
        return { sheet: await reader.readSheet(index) };
      });
    },

    async hosts() {
      const hosts = await bb.sdk.hosts.list();
      return { hosts: hosts.map((host) => ({ id: host.id, name: host.name, status: host.status })) };
    },

    async browse({ hostId, path: directory }) {
      const targetHost = hostId ?? (await defaultHostId());
      const listing = await bb.sdk.hosts.directory({
        hostId: targetHost,
        ...(directory ? { path: directory } : {}),
      });
      const openable = (name: string) =>
        isSupportedPath(name) ||
        [...MARKDOWN_EXTENSIONS, ...HTML_EXTENSIONS].some((extension) => name.toLowerCase().endsWith(`.${extension}`));
      return {
        hostId: targetHost,
        directory: listing.directory,
        parent: listing.parent,
        entries: listing.entries
          .filter((entry) => entry.kind === "directory" || openable(entry.name))
          .sort((left, right) =>
            left.kind !== right.kind ? (left.kind === "directory" ? -1 : 1) : left.name.localeCompare(right.name),
          ),
      };
    },

    async recents() {
      return { recents: await readRecents() };
    },

    async "recents.clear"() {
      await bb.storage.kv.set(RECENTS_KEY, []);
      return { recents: [] };
    },

    async "comments.list"({ docId }) {
      requireDoc(docId);
      return { comments: store.listComments(docId).map(present) };
    },

    async "comments.create"({ docId, anchor, body, docVersion, capture }) {
      const doc = requireDoc(docId);
      if (isDrawing(anchor) && !capture) throw new Error("The drawing's page capture is missing. Reopen the document and try again.");
      const comment = store.createComment({ docId, anchor, body, docVersion });
      if (capture && isDrawing(anchor)) {
        try { await saveDrawing(doc, comment, capture); }
        catch (error) { store.deleteComment(comment.id); throw error; }
      }
      publish([docId]);
      return present(comment);
    },

    async "comments.update"({ id, body }) {
      const existing = store.getComment(id);
      if (!existing) throw new Error("This comment was deleted.");
      const comment = store.updateBody(id, body);
      publish([existing.doc.id]);
      return present(comment);
    },

    async "comments.reply"({ id, body }) {
      const existing = store.getComment(id);
      if (!existing) throw new Error("This comment was deleted.");
      // Another reviewer's comment takes a reply before it is sent: the answer goes back with the PDF.
      if (existing.status === "draft" && !draftReply(existing) && !sharedWithOthers(existing)) {
        throw new Error("This comment is not sent yet; edit it instead.");
      }
      const comment = store.saveReply(id, body);
      publish([existing.doc.id]);
      return present(comment);
    },

    async "comments.discardReply"({ id }) {
      const existing = store.getComment(id);
      if (!existing) throw new Error("This comment was deleted.");
      const comment = store.discardReply(id);
      publish([existing.doc.id]);
      return present(comment);
    },

    async "comments.delete"({ id }) {
      const existing = store.getComment(id);
      const deleted = store.deleteComment(id);
      if (deleted) await Promise.all(drawingFiles(id).map((file) => rm(file, { force: true })));
      if (existing) publish([existing.doc.id]);
      return { deleted };
    },

    async "comments.reopen"({ id }) {
      const existing = store.getComment(id);
      if (!existing) throw new Error("This comment was deleted.");
      const comment = store.reopen(id);
      publish([existing.doc.id]);
      return present(comment);
    },

    async "comments.send"({ docId, ids, target }) {
      const doc = requireDoc(docId);
      const comments = pickComments(docId, ids);

      // Resolve where the message goes before doing any work.
      let projectId: string | null = null;
      let sourceThreadId: string | null = null;
      if (target.kind === "thread") {
        const thread = await bb.sdk.threads.get({ threadId: target.threadId });
        projectId = thread.projectId;
      } else {
        sourceThreadId = target.sourceThreadId;
        projectId = target.projectId;
        if (!projectId && sourceThreadId) {
          projectId = (await bb.sdk.threads.get({ threadId: sourceThreadId })).projectId;
        }
        if (!projectId) throw new Error(NO_PROJECT);
      }

      // Area comments carry a crop of the page and drawings their picture.
      // Attach them as images when bb accepts the upload; otherwise point the
      // agent at a saved file.
      const crops = await commentImages(doc, comments);
      const imageNumbers = new Map<string, number>();
      const imageInputs: { type: "localImage"; path: string }[] = [];
      const unattached = new Map<string, Buffer>();
      for (const comment of comments) {
        const bytes = crops.get(comment.id);
        if (!bytes) continue;
        const type = imageType(bytes) ?? { ext: "png", mime: "image/png" };
        try {
          const uploaded = await bb.sdk.projects.attachments.upload({
            projectId,
            clientFile: new Uint8Array(bytes),
            filename: `comment-${comment.seq}-${comment.id}.${type.ext}`,
            mimeType: type.mime,
          });
          imageInputs.push({ type: "localImage", path: uploaded.path });
          imageNumbers.set(comment.id, imageInputs.length);
        } catch (error) {
          if (isDrawing(comment.anchor)) throw new Error(`Could not attach the drawing: ${String(error)}`);
          bb.log.warn(`attachment upload for ${comment.id}: ${String(error)}`);
          unattached.set(comment.id, bytes);
        }
      }
      const imagePaths = await saveCrops(unattached);

      const handoffInput = buildHandoffInput({
        kind: doc.kind,
        absPath: doc.absPath,
        comments,
        imageNumbers,
        imagePaths,
      });
      const input = [...handoffInput, ...imageInputs];

      let threadId: string;
      if (target.kind === "thread") {
        await bb.sdk.threads.send({ threadId: target.threadId, mode: target.mode ?? "queue-if-active", input });
        threadId = target.threadId;
      } else {
        // Reuse the model and workspace of the thread the panel was opened in.
        type SpawnArgs = Parameters<typeof bb.sdk.threads.spawn>[0];
        const execution: Partial<
          Pick<SpawnArgs, "providerId" | "model" | "reasoningLevel" | "permissionMode">
        > = {};
        let environmentId = target.environmentId;
        if (sourceThreadId) {
          const source = await bb.sdk.threads.get({ threadId: sourceThreadId });
          environmentId ??= source.environmentId;
          execution.providerId = source.providerId;
          const options = await bb.sdk.threads
            .defaultExecutionOptions({ threadId: sourceThreadId })
            .catch(() => null);
          if (options) {
            execution.model = options.model;
            execution.reasoningLevel = options.reasoningLevel;
            execution.permissionMode = options.permissionMode;
          }
        }
        const created = await bb.sdk.threads.spawn({
          projectId,
          environment: environmentId
            ? { type: "reuse", environmentId }
            : { type: "project-default" },
          input,
          title: `Review: ${path.posix.basename(doc.absPath)}`,
          ...execution,
        });
        threadId = created.id;
      }

      const sent = store.markSent(
        comments.map((comment) => comment.id),
        threadId,
      );
      publish([docId]);
      return { threadId, sent };
    },

    async "comments.handoffPrompt"({ docId, ids }) {
      const doc = requireDoc(docId);
      const comments = pickComments(docId, ids);
      const imagePaths = await saveCrops(await commentImages(doc, comments));
      const prompt = buildHandoffMessage({
        kind: doc.kind,
        absPath: doc.absPath,
        comments,
        imageNumbers: new Map(),
        imagePaths,
      });
      return { prompt, ids: comments.map((comment) => comment.id) };
    },

    async "export.signer"() {
      return { signer: await readSigner() };
    },

    async "doc.export"({ docId, signer }) {
      const doc = requireDoc(docId);
      const name = signer?.trim() || null;
      await bb.storage.kv.set(SIGNER_KEY, name ?? "");
      const exported = await exchange.exportPdf(doc, name);
      const file = await exchange.saveExport(exported.bytes);
      const link = await viewer.mintOwnFile({ path: file, name: exported.name, contentType: "application/pdf" });
      return { link, name: exported.name, count: exported.count };
    },

    async "doc.shared"({ docId }) {
      return { shared: await exchange.summary(requireDoc(docId)) };
    },

    async "comments.import"({ docId, into }) {
      const source = requireDoc(docId);
      let target: DocRow = source;
      if (into === "original") {
        const shared = await exchange.sharedIn(source);
        const original = shared ? await exchange.originalOf(source, shared) : null;
        if (!original) throw new Error("The file these comments were written on is not next to this PDF.");
        target = original;
      }
      const result = await exchange.importInto(source, target);
      publish([source.id, target.id]);
      return { docId: target.id, name: path.posix.basename(target.absPath), ...result };
    },

    async "comments.markSent"({ ids, threadId }) {
      const docIds = new Set<string>();
      for (const id of ids) {
        const comment = store.getComment(id);
        if (comment) docIds.add(comment.doc.id);
      }
      const sent = store.markSent(ids, threadId);
      publish([...docIds]);
      return { sent };
    },
  });

  bb.cli.register(
    reviewCli({
      bb,
      store,
      onChanged: publish,
      exchange,
      openDoc: async (absPath, hostId) => {
        const kind = docKindFor(absPath);
        if (!kind) throw new Error("Doc Review opens Markdown, PDF, Word, PowerPoint, Excel, and HTML files.");
        const doc = store.upsertDoc(hostId, absPath, kind);
        if ((await files.version(doc)) === null) throw new Error(`No such file: ${absPath}`);
        return doc;
      },
      readSigner,
    }),
  );
}
