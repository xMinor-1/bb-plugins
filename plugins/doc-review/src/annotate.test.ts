import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, degrees } from "pdf-lib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { annotatePdf, pdfFromImages, readingOrder, readShared, UnreadablePdfError, wrapText } from "./annotate";
import { exportName } from "./exchange";
import { exportFonts } from "./fonts";
import type { Anchor, ReviewComment } from "./types";

let seq = 0;
function comment(anchor: Anchor, body: string): ReviewComment {
  seq += 1;
  return {
    id: `c_${seq}`,
    seq,
    status: "draft",
    anchor,
    body,
    author: null,
    originId: null,
    originFile: null,
    docVersion: null,
    createdAt: seq,
    updatedAt: seq,
    sentAt: null,
    sentThreadId: null,
    agentNote: null,
    resolvedAt: null,
    thread: [],
  };
}

async function samplePdf(rotate = 0): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 400]);
  const second = pdf.addPage([600, 400]);
  second.setRotation(degrees(rotate));
  return await pdf.save();
}

function annotsOf(pdf: PDFDocument, index: number): PDFDict[] {
  const annots = pdf.getPage(index).node.Annots();
  if (!annots) return [];
  return annots.asArray().map((ref) => pdf.context.lookup(ref, PDFDict));
}

const subtype = (annot: PDFDict) => annot.get(PDFName.of("Subtype"))?.toString();
const contents = (annot: PDFDict) => (annot.get(PDFName.of("Contents")) as PDFHexString).decodeText();
const numbers = (annot: PDFDict, key: string) =>
  (annot.get(PDFName.of(key)) as PDFArray).asArray().map((value) => (value as PDFNumber).asNumber());

const text = comment({ kind: "page-text", page: 1, quote: "Выручка", rects: [{ x: 0.5, y: 0.5, w: 0.2, h: 0.05 }] }, "Проверить цифру");
const area = comment({ kind: "page-area", page: 1, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, text: "" }, "Убрать блок");
const drawing = comment(
  {
    kind: "page-drawing",
    page: 2,
    text: "",
    strokes: [
      { tool: "pen", points: [0.1, 0.1, 0.2, 0.2, 0.3, 0.1] },
      { tool: "line", points: [0.1, 0.5, 0.6, 0.5] },
      { tool: "arrow", points: [0.2, 0.8, 0.5, 0.6] },
      { tool: "rect", points: [0.6, 0.6, 0.9, 0.9] },
    ],
  },
  "Сдвинуть сюда",
);
const whole = comment({ kind: "doc" }, "В целом хорошо");
const options = { kind: "presentation" as const, name: "deck.pptx", signer: "Фома", fonts: null, now: new Date(0) };

describe("export with comments", () => {
  it("numbers comments in reading order, whole-document ones first", () => {
    const order = readingOrder([drawing, text, area, whole]).map((item) => [item.n, item.comment.id]);
    expect(order).toEqual([
      [1, whole.id],
      [2, area.id],
      [3, text.id],
      [4, drawing.id],
    ]);
  });

  it("writes one annotation per comment with its number and text", async () => {
    const { bytes, count } = await annotatePdf(await samplePdf(), [text, area, drawing, whole], options);
    expect(count).toBe(4);
    const pdf = await PDFDocument.load(bytes);
    const first = annotsOf(pdf, 0);
    expect(first.map(subtype).sort()).toEqual(["/Highlight", "/Square", "/Text"]);
    expect(first.map(contents).sort()).toEqual(["1. В целом хорошо", "2. Убрать блок", "3. Проверить цифру"]);
    expect((first[0]!.get(PDFName.of("T")) as PDFHexString).decodeText()).toBe("Фома");
    for (const annot of first) expect(annot.get(PDFName.of("AP"))).toBeInstanceOf(PDFDict);

    const [ink] = annotsOf(pdf, 1);
    expect(subtype(ink!)).toBe("/Ink");
    expect(contents(ink!)).toBe("4. Сдвинуть сюда");
    // Pen, line, arrow shaft and head, box.
    expect((ink!.get(PDFName.of("InkList")) as PDFArray).size()).toBe(5);
    // The list of comments follows the document.
    expect(pdf.getPageCount()).toBeGreaterThan(2);
  });

  it("puts a highlight where the text is shown, top-down in fractions", async () => {
    const { bytes } = await annotatePdf(await samplePdf(), [text], options);
    const pdf = await PDFDocument.load(bytes);
    const [highlight] = annotsOf(pdf, 0);
    // Top left, top right, bottom left, bottom right of x 0.5..0.7, y 0.5..0.55 on a 600×400 page.
    expect(numbers(highlight!, "QuadPoints")).toEqual([300, 200, 420, 200, 300, 180, 420, 180]);
  });

  it("follows a rotated page", async () => {
    const turned = comment({ kind: "page-area", page: 2, rect: { x: 0, y: 0, w: 0.5, h: 0.25 }, text: "" }, "x");
    const { bytes } = await annotatePdf(await samplePdf(90), [turned], { ...options, fonts: null });
    const pdf = await PDFDocument.load(bytes);
    const [square] = annotsOf(pdf, 1);
    const [x0, y0, x1, y1] = numbers(square!, "Rect");
    // Shown 400 wide and 600 tall: its top left quarter-width strip is the page's bottom left.
    expect(x0).toBeLessThan(5);
    expect(y0).toBeLessThan(5);
    expect(x1).toBeCloseTo(150 + 1.33, 0);
    expect(y1).toBeCloseTo(200 + 1.33, 0);
  });

  it("carries the comments for Doc Review in another bb", async () => {
    const { bytes } = await annotatePdf(await samplePdf(), [text, whole], options);
    const shared = readShared(await PDFDocument.load(bytes));
    expect(shared?.file).toEqual({ name: "deck.pptx", kind: "presentation", pages: 2 });
    expect(shared?.exportedBy).toBe("Фома");
    expect(shared?.comments.map((item) => [item.id, item.author, item.body])).toEqual([
      [whole.id, "Фома", "В целом хорошо"],
      [text.id, "Фома", "Проверить цифру"],
    ]);
  });

  it("exports an exported PDF again without doubling its marks or its list", async () => {
    const first = await annotatePdf(await samplePdf(), [text, area, drawing, whole], options);
    const firstPdf = await PDFDocument.load(first.bytes);
    // The colleague never imported: the earlier comments ride on, under their author.
    const again = await annotatePdf(first.bytes, [], { ...options, kind: "pdf", name: "deck (comments).pdf", signer: "Коля" });
    const pdf = await PDFDocument.load(again.bytes);
    expect(again.count).toBe(4);
    expect(pdf.getPageCount()).toBe(firstPdf.getPageCount());
    expect(annotsOf(pdf, 0)).toHaveLength(3);
    expect(annotsOf(pdf, 1)).toHaveLength(1);
    const shared = readShared(pdf);
    expect(shared?.file).toMatchObject({ name: "deck.pptx", pages: 2 });
    expect(shared?.comments.map((item) => item.author)).toEqual(["Фома", "Фома", "Фома", "Фома"]);

    // A third round, as when the file is passed on again, still has two pages of the deck and one list.
    const third = await annotatePdf(again.bytes, [], { ...options, kind: "pdf", name: "deck (comments).pdf", signer: "Оля" });
    const thirdPdf = await PDFDocument.load(third.bytes);
    expect(thirdPdf.getPageCount()).toBe(firstPdf.getPageCount());
    expect(readShared(thirdPdf)?.file.pages).toBe(2);
    expect(annotsOf(thirdPdf, 0)).toHaveLength(3);
  });

  it("drops what the earlier export added from the file's bytes", async () => {
    const first = await annotatePdf(await samplePdf(), [text, area, drawing, whole], options);
    const before = (await PDFDocument.load(first.bytes)).context.enumerateIndirectObjects().length;
    // Back with none of the earlier comments kept: their annotations and list leave no objects behind.
    const imported = { ...whole, originId: whole.id, id: "c_local" };
    const again = await annotatePdf(first.bytes, [imported], { ...options, kind: "pdf", name: "deck (comments).pdf" });
    const after = (await PDFDocument.load(again.bytes)).context.enumerateIndirectObjects().length;
    expect(after).toBeLessThan(before);
  });

  it("leaves a document without comments as it was", async () => {
    const { bytes, count } = await annotatePdf(await samplePdf(), [], options);
    expect(count).toBe(0);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  });

  it("refuses what it cannot read so the caller can rebuild it", async () => {
    await expect(annotatePdf(new TextEncoder().encode("not a pdf"), [], options)).rejects.toBeInstanceOf(UnreadablePdfError);
  });

  it("builds a PDF from page pictures", async () => {
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (character) => character.charCodeAt(0),
    );
    const bytes = await pdfFromImages([{ png, width: 300, height: 200 }]);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 300, height: 200 });
  });

  it("breaks a very long word quickly", () => {
    const started = Date.now();
    const lines = wrapText("x".repeat(20_000), 400, (value) => value.length * 6);
    expect(lines.every((line) => line.length * 6 <= 400)).toBe(true);
    expect(lines.join("")).toHaveLength(20_000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("wraps text by width and breaks words that do not fit", () => {
    const measure = (value: string) => value.length;
    expect(wrapText("one two three", 7, measure)).toEqual(["one two", "three"]);
    expect(wrapText("abcdefghij", 4, measure)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\n\nb", 4, measure)).toEqual(["a", "", "b"]);
  });

  it("names the export in the panel's language, with one suffix", () => {
    expect(exportName("deck.pptx")).toBe("deck (comments).pdf");
    expect(exportName("deck.pptx", "ru")).toBe("deck (комментарии).pdf");
    expect(exportName("deck (comments).pdf", "ru")).toBe("deck (комментарии).pdf");
  });

  const pdftotext = (() => {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!pdftotext)("writes the list of comments in Russian when asked", async () => {
    const fonts = await exportFonts();
    if (!fonts) return;
    const whole = comment({ kind: "doc" }, "Поправить вывод");
    const { bytes } = await annotatePdf(await samplePdf(), [whole], { ...options, fonts, lang: "ru" });
    const dir = mkdtempSync(path.join(tmpdir(), "doc-review-"));
    const file = path.join(dir, "out.pdf");
    writeFileSync(file, bytes);
    const text = execFileSync("pdftotext", [file, "-"]).toString();
    rmSync(dir, { recursive: true });
    expect(text).toContain("Комментарии");
    expect(text).toContain("Весь документ");
    expect(text).toContain("1 комментарий");
  });
});
