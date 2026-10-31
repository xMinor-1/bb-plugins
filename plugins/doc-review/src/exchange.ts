// Sharing comments through PDFs: exporting a paged document with its comments
// written in (src/annotate.ts), and finding and importing the comments that
// another bb's export carries (src/share.ts). The glue between those, the
// store, and the PDF a document is shown from.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { annotatePdf, pdfFromImages, readShared, UnreadablePdfError, type ExportLang } from "./annotate.js";
import type { DocFiles } from "./files.js";
import { exportFonts } from "./fonts.js";
import { renderWidth, type Renderer } from "./render.js";
import { SHARE_FILE, type SharedReview } from "./share.js";
import { docIdFor, type DocRow, type ReviewStore } from "./store.js";
import { docKindFor, isPaged, type DocKind } from "./types.js";

const run = promisify(execFile);

/** Page pictures for a PDF that cannot be edited, in pixels across. */
const REBUILD_WIDTH = 2400;
/** Exports wait this long for their download before they are cleared. */
const EXPORT_KEEP_MS = 2 * 60 * 60 * 1000;
/** A PDF is read whole for its comments only up to this size. */
const SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** `deck.pptx` → `deck (comments).pdf`; an export of an export keeps one suffix. */
export function exportName(fileName: string, lang: ExportLang = "en"): string {
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/ \((comments|комментарии)\)$/, "");
  return `${stem} (${lang === "ru" ? "комментарии" : "comments"}).pdf`;
}

export interface SharedSummary {
  /** Who exported the file. */
  by: string | null;
  /** The file the comments were written on. */
  file: string;
  count: number;
  /** Comments not yet in this PDF's own list. */
  newHere: number;
  /** That file, when it sits next to this PDF; with the comments not yet on it. */
  original: { path: string; kind: DocKind; newThere: number } | null;
}

export function createExchange(deps: {
  store: ReviewStore;
  files: DocFiles;
  renderer: Renderer;
  dataDir: string;
  pdfFor: (doc: DocRow) => Promise<string>;
  currentVersion: (doc: DocRow) => Promise<string>;
  log: (message: string) => void;
}) {
  const { store, files, renderer } = deps;
  const exportsDir = path.join(deps.dataDir, "exports");
  const scans = new Map<string, { version: string; shared: Promise<SharedReview | null> }>();

  /** The PDF for `doc` with its comments in it. */
  async function exportPdf(
    doc: DocRow,
    signer: string | null,
    lang: ExportLang = "en",
  ): Promise<{ bytes: Uint8Array; count: number; name: string }> {
    if (!isPaged(doc.kind)) throw new Error("Only PDF, Word, and PowerPoint files are exported with comments.");
    const version = await deps.currentVersion(doc);
    const pdf = await deps.pdfFor(doc);
    const name = path.posix.basename(doc.absPath);
    const options = { kind: doc.kind, name, signer, fonts: await exportFonts(), lang };
    const comments = store.listComments(doc.id);
    let result: { bytes: Uint8Array; count: number };
    try {
      result = await annotatePdf(new Uint8Array(await readFile(pdf)), comments, options);
    } catch (error) {
      if (!(error instanceof UnreadablePdfError)) throw error;
      // Encrypted or damaged: the same pages as pictures, so the comments still have a place.
      deps.log(`rebuilding ${doc.absPath} from page images: ${error.message}`);
      const sizes = await renderer.pageSizes(doc.id, version, pdf);
      const pages: { png: Uint8Array; width: number; height: number }[] = [];
      for (const [index, size] of sizes.entries()) {
        const image = await renderer.pageImage(doc.id, version, pdf, index + 1, renderWidth(size, REBUILD_WIDTH));
        pages.push({ png: new Uint8Array(await readFile(image)), width: size.width, height: size.height });
      }
      result = await annotatePdf(await pdfFromImages(pages), comments, options);
    }
    return { ...result, name: exportName(name, lang) };
  }

  /** Writes an export where the plugin keeps them, clearing old ones; returns its path. */
  async function saveExport(bytes: Uint8Array): Promise<string> {
    await mkdir(exportsDir, { recursive: true });
    const now = Date.now();
    for (const entry of await readdir(exportsDir).catch(() => [] as string[])) {
      const file = path.join(exportsDir, entry);
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs > EXPORT_KEEP_MS) await rm(file, { force: true });
    }
    const file = path.join(exportsDir, `${randomUUID()}.pdf`);
    await writeFile(file, bytes);
    return file;
  }

  async function scan(pdf: string): Promise<SharedReview | null> {
    try {
      // pdfdetach lists attachments without reading the whole file: most PDFs stop here.
      const { stdout } = await run("pdfdetach", ["-list", "-enc", "UTF-8", pdf], { timeout: 20_000 });
      const listed = stdout.split("\n").some((line) => /^\d+: (.*)$/.exec(line.trim())?.[1] === SHARE_FILE);
      if (!listed) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        deps.log(`looking for comments in ${pdf}: ${String(error)}`);
        return null;
      }
      // No pdfdetach: read the PDF itself below.
    }
    const info = await stat(pdf).catch(() => null);
    if (!info || info.size > SCAN_MAX_BYTES) return null;
    try {
      // readShared unpacks the attachment with a ceiling.
      return readShared(await PDFDocument.load(await readFile(pdf), { updateMetadata: false }));
    } catch {
      return null;
    }
  }

  /** The comments a PDF carries from a Doc Review export, read once per version of the file. */
  async function sharedIn(doc: DocRow): Promise<SharedReview | null> {
    if (doc.kind !== "pdf") return null;
    const version = await deps.currentVersion(doc);
    const cached = scans.get(doc.id);
    if (cached?.version === version) return await cached.shared;
    const shared = deps.pdfFor(doc).then(scan);
    scans.set(doc.id, { version, shared });
    return await shared;
  }

  /**
   * The file the comments were written on: a file of that name next to the
   * PDF (a colleague who keeps the deck and the PDF together), or else the
   * document here that already holds them (a PDF coming back with answers).
   */
  async function originalOf(doc: DocRow, shared: SharedReview): Promise<DocRow | null> {
    const exists = async (row: DocRow) => (await files.version(row)) !== null;
    // The name comes from the attachment, so it is checked to be a bare name before it meets a path.
    const name = shared.file.name;
    if (path.posix.basename(name) === name && !name.includes("\\")) {
      const candidate = path.posix.join(path.posix.dirname(doc.absPath), name);
      const kind = docKindFor(candidate);
      if (candidate !== doc.absPath && kind && isPaged(kind)) {
        const row: DocRow = { id: docIdFor(doc.hostId, candidate), hostId: doc.hostId, absPath: candidate, kind };
        if (await exists(row)) return row;
      }
    }
    for (const id of store.docsHolding(shared.comments.map((comment) => comment.id))) {
      const row = id === doc.id ? null : store.getDoc(id);
      if (row && isPaged(row.kind) && (await exists(row))) return row;
    }
    return null;
  }

  async function summary(doc: DocRow): Promise<SharedSummary | null> {
    const shared = await sharedIn(doc);
    if (!shared || shared.comments.length === 0) return null;
    const original = await originalOf(doc, shared);
    return {
      by: shared.exportedBy,
      file: original ? path.posix.basename(original.absPath) : shared.file.name,
      count: shared.comments.length,
      newHere: store.countPending(doc.id, shared.comments),
      original: original
        ? {
            path: original.absPath,
            kind: original.kind,
            // A document Doc Review has not seen has none of them yet.
            newThere: store.getDoc(original.id) ? store.countPending(original.id, shared.comments) : shared.comments.length,
          }
        : null,
    };
  }

  /** Merges the comments `source` carries into `target`: the PDF itself, or the file they were written on. */
  async function importInto(source: DocRow, target: DocRow): Promise<{ added: number; updated: number }> {
    const shared = await sharedIn(source);
    if (!shared) throw new Error("This PDF carries no comments from Doc Review.");
    if (!isPaged(target.kind)) throw new Error("Comments from a PDF go into a PDF, Word, or PowerPoint file.");
    const row = store.upsertDoc(target.hostId, target.absPath, target.kind);
    const targetName = path.posix.basename(target.absPath);
    return store.importComments({
      docId: row.id,
      docVersion: await deps.currentVersion(row),
      originFile: shared.file.name === targetName ? null : shared.file.name,
      comments: shared.comments,
    });
  }

  return { exportPdf, saveExport, sharedIn, originalOf, summary, importInto };
}

export type Exchange = ReturnType<typeof createExchange>;
