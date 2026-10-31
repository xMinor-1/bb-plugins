// The text of an attachment, for an agent. Text files and PDF only: anything
// else is described, not read. Runs on the machine with the mailbox; the file
// itself never leaves it, only the text does.
import { normalizeText } from "../shared/mail-text.js";
import { UserError } from "./errors.js";
import { htmlToText } from "./ews/parse.js";

const TEXT = new Set(["txt", "text", "csv", "tsv", "md", "markdown", "json", "xml", "log", "ini", "cfg", "conf", "yaml", "yml", "ics", "vcf", "sql", "eml"]);
const HTML = new Set(["html", "htm"]);

export type Readable = "text" | "html" | "pdf" | null;

/** Whether bb can turn this attachment into text, judged by its name and declared type. */
export function readableAs(name: string, contentType: string | null): Readable {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const type = (contentType ?? "").toLowerCase();
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  if (HTML.has(ext) || type === "text/html") return "html";
  if (TEXT.has(ext) || type.startsWith("text/") || type === "application/json" || type === "application/xml") return "text";
  return null;
}

/** UTF-8 or UTF-16 by their marks; text that is not valid UTF-8 is read as Windows-1251, the usual Russian Windows encoding. */
export function decodeText(content: Buffer): string {
  if (content[0] === 0xff && content[1] === 0xfe) return new TextDecoder("utf-16le").decode(content.subarray(2));
  if (content[0] === 0xfe && content[1] === 0xff) return new TextDecoder("utf-16be").decode(content.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(content);
  } catch {
    return new TextDecoder("windows-1251").decode(content);
  }
}

/** A PDF is read up to this many pages and for this long; the agent is told where it stopped. */
export const PDF_MAX_PAGES = 200;
export const PDF_MAX_MS = 60_000;

export interface ReadLimits {
  /** The tool call's signal: a stopped turn stops the reading between pages. */
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
  readonly maxMs?: number;
  /** For tests: the clock. */
  readonly now?: () => number;
}

/** Not the file's fault: the reading was stopped from outside. */
class Stopped extends Error {}

async function pdfText(content: Buffer, limits: ReadLimits): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const now = limits.now ?? Date.now;
  const deadline = now() + (limits.maxMs ?? PDF_MAX_MS);
  const maxPages = limits.maxPages ?? PDF_MAX_PAGES;
  // unpdf's pdf.js build has no eval path for fonts; fonts are not loaded at all, only text is read.
  const pdf = await getDocumentProxy(new Uint8Array(content), { disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const total = pdf.numPages;
    const pages: { number: number; text: string }[] = [];
    let note = total > maxPages ? `(Only the first ${maxPages} of ${total} pages were read.)` : "";
    for (let number = 1; number <= Math.min(total, maxPages); number++) {
      if (limits.signal?.aborted) throw new Stopped("stopped");
      if (number > 1 && now() > deadline) {
        note = `(Reading stopped after ${number - 1} of ${total} pages: the file takes too long to read.)`;
        break;
      }
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      page.cleanup();
      const text = items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
      pages.push({ number, text: text.trim() });
    }
    const body = pages.some((page) => page.text)
      ? pages.map((page) => `[page ${page.number}]\n${page.text}`).join("\n\n")
      : "(The PDF has no text layer: it is probably a scan. Ask the user to read it.)";
    return note ? `${body}\n\n${note}` : body;
  } finally {
    // Frees the parsed document; cleanup() alone keeps it in memory.
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

export async function attachmentText(name: string, contentType: string | null, content: Buffer, limits: ReadLimits = {}): Promise<string> {
  const as = readableAs(name, contentType);
  if (as === "pdf") {
    return pdfText(content, limits).catch((error: unknown) => {
      if (error instanceof Stopped) throw new UserError(`Reading ${name} was stopped.`);
      throw new UserError(`${name} could not be read as PDF: it may be damaged or protected with a password.`);
    });
  }
  if (as === "html") return htmlToText(decodeText(content));
  if (as === "text") return normalizeText(decodeText(content));
  throw new UserError(`${name} is not a text file or a PDF, so it cannot be read here. Ask the user to open it in Outlook.`);
}
