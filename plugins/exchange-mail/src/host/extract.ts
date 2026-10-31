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

async function pdfText(content: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // unpdf's pdf.js build has no eval path for fonts; fonts are not loaded at all, only text is read.
  const pdf = await getDocumentProxy(new Uint8Array(content), { disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).map((page, n) => `[page ${n + 1}]\n${page.trim()}`).join("\n\n");
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}

export async function attachmentText(name: string, contentType: string | null, content: Buffer): Promise<string> {
  const as = readableAs(name, contentType);
  if (as === "pdf") {
    const text = await pdfText(content).catch(() => {
      throw new UserError(`${name} could not be read as PDF: it may be damaged or protected with a password.`);
    });
    if (!text.replace(/\[page \d+\]/g, "").trim()) return "(The PDF has no text layer: it is probably a scan. Ask the user to read it.)";
    return text;
  }
  if (as === "html") return htmlToText(decodeText(content));
  if (as === "text") return normalizeText(decodeText(content));
  throw new UserError(`${name} is not a text file or a PDF, so it cannot be read here. Ask the user to open it in Outlook.`);
}
