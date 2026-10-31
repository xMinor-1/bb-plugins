// A copy of a paged document with its review comments written in, for
// sending on. Every comment becomes a PDF annotation that any viewer shows (a
// highlight, a box, a drawing, or a note for the whole document) with the
// comment as its text and a numbered badge in its picture; closing pages list
// every comment and its replies by number, for viewers that hide annotation
// text; and the comments themselves ride along as an attachment that Doc
// Review in another bb imports (src/share.ts). Exporting a PDF that came from
// an export first takes the earlier additions out, so a file can go back and
// forth. The source file is never touched.
import { inflateSync } from "node:zlib";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { DRAW_COLOR, strokeBounds } from "./drawing.js";
import { buildShared, parseShared, SHARE_FILE, UNNAMED, type SharedReview } from "./share.js";
import {
  isPageAnchor,
  pageNoun,
  replyAuthor,
  truncate,
  type DocKind,
  type PageAnchor,
  type Rect,
  type ReviewComment,
  type Stroke,
} from "./types.js";

/** pdf-lib's `LiteralObject`, which the package does not export. */
type Literal = Parameters<PDFDocument["context"]["obj"]>[0] & Record<string, unknown>;

export interface ExportFonts {
  /** A TrueType or OpenType font with Cyrillic and other scripts beyond Latin. */
  regular: Uint8Array;
  bold: Uint8Array | null;
}

export interface ExportOptions {
  kind: DocKind;
  /** The file's name: the title of the list, and the file the comments are on. */
  name: string;
  /** The name this bb's user signs their comments with; null leaves them unsigned. */
  signer: string | null;
  /** Without them the list falls back to a Latin-only built-in font. */
  fonts: ExportFonts | null;
  /** The language of the list of comments; English when absent (the CLI, agents). */
  lang?: ExportLang;
  now?: Date;
}

export type ExportLang = "en" | "ru";

const ruComments = (n: number) => {
  const lastTwo = n % 100;
  const last = n % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "комментариев";
  if (last === 1) return "комментарий";
  return last >= 2 && last <= 4 ? "комментария" : "комментариев";
};

/** The words of the list of comments at the end of an exported PDF. */
const LIST_WORDS = {
  en: {
    title: "Comments",
    count: (n: number) => `${n} comment${n === 1 ? "" : "s"}`,
    page: (kind: DocKind, n: number) => `${pageNoun(kind)} ${n}`,
    wholeDocument: "Whole document",
    agent: "Agent",
    agentOf: (name: string) => `${name}'s agent`,
    reply: "Reply",
  },
  ru: {
    title: "Комментарии",
    count: (n: number) => `${n} ${ruComments(n)}`,
    page: (kind: DocKind, n: number) => `${kind === "presentation" ? "Слайд" : "Страница"} ${n}`,
    wholeDocument: "Весь документ",
    agent: "Агент",
    agentOf: (name: string) => `Агент (${name})`,
    reply: "Ответ",
  },
};

/** The source cannot be opened for editing (encrypted or damaged); rebuild it from page images. */
export class UnreadablePdfError extends Error {}

interface Placed {
  n: number;
  comment: ReviewComment;
  anchor: PageAnchor | null;
}

/** Every annotation an export adds is named with this, so a later export can take it out. */
const NAME_PREFIX = "doc-review-";
const RED = hexColor(DRAW_COLOR);
const YELLOW = { r: 1, g: 0.85, b: 0.2 };
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const QUOTE_MAX = 300;
/** The list shows a comment or reply up to this length; the annotation keeps all of it. */
const LIST_TEXT_MAX = 5000;
/** More characters than any line of the list can hold. */
const WRAP_SPAN = 400;
/** The largest attachment of comments read back, unpacked. */
const SHARED_MAX_BYTES = 16 * 1024 * 1024;
/** Helvetica Bold's digits are all this wide, in thousandths of the font size. */
const DIGIT_WIDTH = 0.556;

function hexColor(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/** The part of the page an anchor covers, in fractions of the page as shown. */
function anchorBox(anchor: PageAnchor): Box {
  if (anchor.kind === "page-area") {
    const { x, y, w, h } = anchor.rect;
    return { x0: x, y0: y, x1: x + w, y1: y + h };
  }
  if (anchor.kind === "page-drawing") {
    return strokeBounds(anchor.strokes) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  }
  const rects = anchor.rects;
  if (rects.length === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(...rects.map((rect) => rect.x)),
    y0: Math.min(...rects.map((rect) => rect.y)),
    x1: Math.max(...rects.map((rect) => rect.x + rect.w)),
    y1: Math.max(...rects.map((rect) => rect.y + rect.h)),
  };
}

/**
 * Where a mark's number goes and the mark is read from: its top left corner,
 * or for a drawing the first stroke's, where the user started.
 */
function markCorner(anchor: PageAnchor): { x: number; y: number } {
  const box = anchor.kind === "page-drawing" && anchor.strokes[0] ? strokeBounds([anchor.strokes[0]])! : anchorBox(anchor);
  return { x: box.x0, y: box.y0 };
}

/**
 * The comments an export carries, numbered in reading order: those on the
 * whole document first, then page by page, top to bottom and left to right.
 * Comments that point elsewhere (lines of a Markdown file, cells) are left out.
 */
export function readingOrder(comments: readonly ReviewComment[]): Placed[] {
  const whole = comments
    .filter((comment) => comment.anchor.kind === "doc")
    .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
  const onPages = comments
    .filter((comment) => isPageAnchor(comment.anchor))
    .map((comment) => {
      const anchor = comment.anchor as PageAnchor;
      return { comment, anchor, corner: markCorner(anchor) };
    })
    .sort(
      (a, b) =>
        a.anchor.page - b.anchor.page ||
        // Marks on about the same line read left to right.
        Math.round(a.corner.y * 50) - Math.round(b.corner.y * 50) ||
        a.corner.x - b.corner.x ||
        a.comment.createdAt - b.comment.createdAt,
    );
  return [
    ...whole.map((comment) => ({ comment, anchor: null })),
    ...onPages.map(({ comment, anchor }) => ({ comment, anchor })),
  ].map((item, index) => ({ ...item, n: index + 1 }));
}

/**
 * Maps the panel's coordinates (fractions of the page as shown, from its top
 * left) to the page's own PDF space, through its rotation. Pages are shown
 * and rendered from their media box, as pdftoppm does.
 */
class PageFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotation: 0 | 90 | 180 | 270;

  constructor(page: PDFPage) {
    const box = page.getMediaBox();
    this.x = box.x;
    this.y = box.y;
    this.w = box.width;
    this.h = box.height;
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    this.rotation = angle === 90 || angle === 180 || angle === 270 ? angle : 0;
  }

  /** The width and height of the page as shown, in points. */
  get shownWidth(): number {
    return this.rotation % 180 === 90 ? this.h : this.w;
  }

  get shownHeight(): number {
    return this.rotation % 180 === 90 ? this.w : this.h;
  }

  /** Rounded to a hundredth of a point, which keeps the file small. */
  at(u: number, v: number): [number, number] {
    const [x, y] = this.turn(u, v);
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  }

  private turn(u: number, v: number): [number, number] {
    switch (this.rotation) {
      case 90:
        return [this.x + v * this.w, this.y + u * this.h];
      case 180:
        return [this.x + (1 - u) * this.w, this.y + v * this.h];
      case 270:
        return [this.x + (1 - v) * this.w, this.y + (1 - u) * this.h];
      default:
        return [this.x + u * this.w, this.y + (1 - v) * this.h];
    }
  }

  /** A point given in points from the shown page's top left. */
  atPoints(px: number, py: number): [number, number] {
    return this.at(px / this.shownWidth, py / this.shownHeight);
  }

  /** The line width for marks on this page, in points. */
  get lineWidth(): number {
    return Math.min(4, Math.max(1.25, Math.min(this.shownWidth, this.shownHeight) / 300));
  }

  get badgeRadius(): number {
    return Math.min(11, Math.max(6, Math.min(this.shownWidth, this.shownHeight) / 60));
  }
}

const num = (value: number) => (Math.round(value * 100) / 100).toString();

function boundsOf(points: readonly [number, number][], margin: number): [number, number, number, number] {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
}

function union(a: number[], b: number[]): number[] {
  return [Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.max(a[2]!, b[2]!), Math.max(a[3]!, b[3]!)];
}

/** A stroke as polylines in PDF space: an arrow is its shaft and its head. */
function strokeLines(stroke: Stroke, frame: PageFrame, head: number): [number, number][][] {
  const p = stroke.points;
  const n = p.length;
  if (n < 2) return [];
  const first = frame.at(p[0]!, p[1]!);
  const last = frame.at(p[n - 2]!, p[n - 1]!);
  switch (stroke.tool) {
    case "line":
      return [[first, last]];
    case "rect": {
      const corners: [number, number][] = [first, frame.at(p[n - 2]!, p[1]!), last, frame.at(p[0]!, p[n - 1]!)];
      return [[...corners, first]];
    }
    case "arrow": {
      // The mapping only turns and moves the page, so angles hold in PDF space.
      const angle = Math.atan2(last[1] - first[1], last[0] - first[0]);
      const spread = Math.PI / 7;
      const left: [number, number] = [last[0] - head * Math.cos(angle - spread), last[1] - head * Math.sin(angle - spread)];
      const right: [number, number] = [last[0] - head * Math.cos(angle + spread), last[1] - head * Math.sin(angle + spread)];
      return [
        [first, last],
        [left, last, right],
      ];
    }
    default: {
      const line: [number, number][] = [];
      for (let i = 0; i + 1 < n; i += 2) line.push(frame.at(p[i]!, p[i + 1]!));
      // A tap is a dot: a round cap on a line too short to see.
      if (line.length === 1) line.push([line[0]![0] + 0.01, line[0]![1]]);
      return [line];
    }
  }
}

/**
 * The numbered badge for a mark whose top left corner is at `corner`
 * (fractions of the shown page): a red disc up and to the left of it, inside
 * the page, as content for the mark's appearance and its bounds.
 */
function badge(frame: PageFrame, n: number, corner: { x: number; y: number }): { content: string; rect: number[] } {
  const radius = frame.badgeRadius;
  const pad = radius + 2;
  const cx = Math.min(frame.shownWidth - pad, Math.max(pad, corner.x * frame.shownWidth - radius * 0.8));
  const cy = Math.min(frame.shownHeight - pad, Math.max(pad, corner.y * frame.shownHeight - radius * 0.8));
  const [x, y] = frame.atPoints(cx, cy);
  const k = radius * 0.5523;
  const disc = [
    `${num(x + radius)} ${num(y)} m`,
    `${num(x + radius)} ${num(y + k)} ${num(x + k)} ${num(y + radius)} ${num(x)} ${num(y + radius)} c`,
    `${num(x - k)} ${num(y + radius)} ${num(x - radius)} ${num(y + k)} ${num(x - radius)} ${num(y)} c`,
    `${num(x - radius)} ${num(y - k)} ${num(x - k)} ${num(y - radius)} ${num(x)} ${num(y - radius)} c`,
    `${num(x + k)} ${num(y - radius)} ${num(x + radius)} ${num(y - k)} ${num(x + radius)} ${num(y)} c`,
  ].join(" ");
  const label = String(n);
  const size = radius * (label.length === 1 ? 1.15 : label.length === 2 ? 0.95 : 0.75);
  const width = DIGIT_WIDTH * size * label.length;
  // Upright on the page as shown: the text turns with the page's rotation.
  const [tx, ty] = frame.atPoints(cx - width / 2, cy + size * 0.36);
  const angle = (frame.rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(angle));
  const sin = Math.round(Math.sin(angle));
  const content = [
    `q ${num(RED.r)} ${num(RED.g)} ${num(RED.b)} rg 1 1 1 RG ${num(Math.max(1, radius * 0.15))} w ${disc} b Q`,
    `q 1 1 1 rg BT /DRBadge ${num(size)} Tf ${cos} ${sin} ${-sin} ${cos} ${num(tx)} ${num(ty)} Tm (${label}) Tj ET Q`,
  ].join("\n");
  const outer = radius + 1;
  return { content, rect: [x - outer, y - outer, x + outer, y + outer] };
}

const BADGE_FONT: Literal = {
  Font: {
    DRBadge: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica-Bold", Encoding: "WinAnsiEncoding" },
  },
};

class Annotator {
  private readonly date: PDFString;

  constructor(
    private readonly pdf: PDFDocument,
    private readonly signer: string | null,
    now: Date,
  ) {
    this.date = PDFString.fromDate(now);
  }

  private appearance(rect: number[], content: string, resources: Literal): PDFRef {
    const context = this.pdf.context;
    const stream = context.flateStream(content, { Type: "XObject", Subtype: "Form", BBox: rect, Resources: resources });
    return context.register(stream);
  }

  private add(page: PDFPage, item: Placed, fields: Literal, rect: number[], appearance: PDFRef): void {
    const context = this.pdf.context;
    const dict = context.obj({
      Type: "Annot",
      Rect: rect,
      F: 4,
      P: page.ref,
      M: this.date,
      CreationDate: this.date,
      ...fields,
    });
    dict.set(PDFName.of("Contents"), PDFHexString.fromText(`${item.n}. ${item.comment.body}`));
    dict.set(PDFName.of("NM"), PDFString.of(`${NAME_PREFIX}${item.comment.originId ?? item.comment.id}`));
    const author = item.comment.author ?? this.signer;
    if (author) dict.set(PDFName.of("T"), PDFHexString.fromText(author));
    dict.set(PDFName.of("AP"), context.obj({ N: appearance }));
    page.node.addAnnot(context.register(dict));
  }

  /** Adds the badge to a mark's picture and bounds. */
  private withBadge(frame: PageFrame, item: Placed, box: number[], content: string, resources: Literal = {}) {
    const mark = badge(frame, item.n, markCorner(item.anchor!));
    return {
      rect: union(box, mark.rect),
      content: `${content}\n${mark.content}`,
      resources: { ...resources, ...BADGE_FONT },
    };
  }

  highlight(page: PDFPage, frame: PageFrame, item: Placed, rects: readonly Rect[]): void {
    if (rects.length === 0) return;
    const quads = rects.map((rect) => [
      frame.at(rect.x, rect.y),
      frame.at(rect.x + rect.w, rect.y),
      frame.at(rect.x, rect.y + rect.h),
      frame.at(rect.x + rect.w, rect.y + rect.h),
    ]);
    const { r, g, b } = YELLOW;
    const paint = quads
      .map(
        ([tl, tr, bl, br]) =>
          `${num(tl![0])} ${num(tl![1])} m ${num(tr![0])} ${num(tr![1])} l ${num(br![0])} ${num(br![1])} l ${num(bl![0])} ${num(bl![1])} l h f`,
      )
      .join("\n");
    const look = this.withBadge(frame, item, boundsOf(quads.flat(), 1), `q /DRMultiply gs ${num(r)} ${num(g)} ${num(b)} rg\n${paint}\nQ`, {
      ExtGState: { DRMultiply: { Type: "ExtGState", BM: "Multiply" } },
    });
    this.add(
      page,
      item,
      { Subtype: "Highlight", C: [r, g, b], QuadPoints: quads.flat().flat() },
      look.rect,
      this.appearance(look.rect, look.content, look.resources),
    );
  }

  box(page: PDFPage, frame: PageFrame, item: Placed, rect: Rect): void {
    const width = frame.lineWidth;
    const [x0, y0, x1, y1] = boundsOf([frame.at(rect.x, rect.y), frame.at(rect.x + rect.w, rect.y + rect.h)], 0);
    const { r, g, b } = RED;
    const look = this.withBadge(
      frame,
      item,
      [x0 - width, y0 - width, x1 + width, y1 + width],
      `q ${num(r)} ${num(g)} ${num(b)} RG ${num(width)} w ${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re S Q`,
    );
    this.add(
      page,
      item,
      { Subtype: "Square", C: [r, g, b], BS: { W: width, S: "S" } },
      look.rect,
      this.appearance(look.rect, look.content, look.resources),
    );
  }

  drawing(page: PDFPage, frame: PageFrame, item: Placed, strokes: readonly Stroke[]): void {
    const width = frame.lineWidth;
    const lines = strokes.flatMap((stroke) => strokeLines(stroke, frame, width * 5));
    if (lines.length === 0) return;
    const { r, g, b } = RED;
    const paths = lines
      .map((line) => line.map(([x, y], index) => `${num(x)} ${num(y)} ${index === 0 ? "m" : "l"}`).join(" ") + " S")
      .join("\n");
    const look = this.withBadge(
      frame,
      item,
      boundsOf(lines.flat(), width * 2),
      `q ${num(r)} ${num(g)} ${num(b)} RG ${num(width)} w 1 J 1 j\n${paths}\nQ`,
    );
    this.add(
      page,
      item,
      { Subtype: "Ink", C: [r, g, b], BS: { W: width, S: "S" }, InkList: lines.map((line) => line.flat()) },
      look.rect,
      this.appearance(look.rect, look.content, look.resources),
    );
  }

  /** A note with its number for the whole document, along the first page's top left. */
  note(page: PDFPage, frame: PageFrame, item: Placed, index: number): void {
    const size = 18;
    const left = 10 + index * (size + 6);
    const box = boundsOf([frame.atPoints(left, 10), frame.atPoints(left + size, 10 + size)], 0);
    const [x0, y0, x1, y1] = box;
    const { r, g, b } = YELLOW;
    const label = String(item.n);
    const font = label.length === 1 ? 11 : label.length === 2 ? 9 : 7;
    const [tx, ty] = frame.atPoints(left + size / 2 - (DIGIT_WIDTH * font * label.length) / 2, 10 + size / 2 + font * 0.36);
    const angle = (frame.rotation * Math.PI) / 180;
    const cos = Math.round(Math.cos(angle));
    const sin = Math.round(Math.sin(angle));
    const content = [
      `q ${num(r)} ${num(g)} ${num(b)} rg 0.45 0.35 0 RG 1 w ${num(x0 + 0.5)} ${num(y0 + 0.5)} ${num(x1 - x0 - 1)} ${num(y1 - y0 - 1)} re B Q`,
      `q 0.25 0.2 0 rg BT /DRBadge ${font} Tf ${cos} ${sin} ${-sin} ${cos} ${num(tx)} ${num(ty)} Tm (${label}) Tj ET Q`,
    ].join("\n");
    this.add(
      page,
      item,
      { Subtype: "Text", Name: "Comment", C: [r, g, b], Open: false },
      box,
      this.appearance(box, content, BADGE_FONT),
    );
  }
}

/** Text a built-in font can encode: characters outside it become "?". */
function encodable(font: PDFFont, builtIn: boolean): (text: string) => string {
  const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\t/g, "  ");
  if (!builtIn) return clean;
  const known = new Set(font.getCharacterSet());
  return (text) =>
    [...clean(text)].map((character) => (character === "\n" || known.has(character.codePointAt(0)!) ? character : "?")).join("");
}

/** Lines of `text` no wider than `width`, breaking words that do not fit at all. */
export function wrapText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      let rest = word;
      while (rest.length > 1 && measure(rest) > width) {
        // The longest start that fits, found by halving; a line never holds more than WRAP_SPAN characters.
        let low = 1;
        let high = Math.min(rest.length - 1, WRAP_SPAN);
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (measure(rest.slice(0, middle)) <= width) low = middle;
          else high = middle - 1;
        }
        lines.push(rest.slice(0, low));
        rest = rest.slice(low);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

async function listFonts(pdf: PDFDocument, fonts: ExportFonts | null) {
  if (fonts) {
    try {
      pdf.registerFontkit(fontkit);
      const regular = await pdf.embedFont(fonts.regular, { subset: true });
      const bold = fonts.bold ? await pdf.embedFont(fonts.bold, { subset: true }) : regular;
      return { regular, bold, builtIn: false };
    } catch {
      // An unusable font file: fall back to the built-in one below.
    }
  }
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold, builtIn: true };
}

/** Closing pages, the size of the first page as shown, with every comment and its replies by number. */
async function addList(
  pdf: PDFDocument,
  placed: Placed[],
  title: string,
  kind: DocKind,
  signer: string | null,
  fonts: ExportFonts | null,
  lang: ExportLang,
): Promise<void> {
  const first = new PageFrame(pdf.getPage(0));
  const width = first.shownWidth;
  const height = first.shownHeight;
  const margin = Math.max(36, Math.min(width, height) * 0.07);
  const { regular, bold, builtIn } = await listFonts(pdf, fonts);
  const fit = encodable(regular, builtIn);
  // The built-in font has no Cyrillic: without a system font the list stays in English.
  const words = LIST_WORDS[builtIn ? "en" : lang];
  const indent = 28;
  const textWidth = width - margin * 2 - indent;
  const measure = (font: PDFFont, size: number) => (text: string) => font.widthOfTextAtSize(text, size);

  let page = pdf.addPage([width, height]);
  let y = height - margin;
  const ensure = (needed: number) => {
    if (y - needed >= margin) return;
    page = pdf.addPage([width, height]);
    y = height - margin;
  };

  page.drawText(fit(words.title), { x: margin, y: y - 20, size: 20, font: bold, color: INK });
  y -= 30;
  const count = words.count(placed.length);
  for (const line of wrapText(fit(`${title} — ${count}`), width - margin * 2, measure(regular, 10))) {
    page.drawText(line, { x: margin, y: y - 10, size: 10, font: regular, color: MUTED });
    y -= 14;
  }
  y -= 14;

  for (const item of placed) {
    const place = item.anchor ? words.page(kind, item.anchor.page) : words.wholeDocument;
    const author = item.comment.author ?? signer;
    const label = author ? `${place} — ${author}` : place;
    const rawQuote =
      item.anchor?.kind === "page-text" ? item.anchor.quote : item.anchor?.kind === "page-area" ? item.anchor.text : "";
    const quote = rawQuote.trim()
      ? wrapText(fit(`«${truncate(rawQuote.trim(), QUOTE_MAX)}»`), textWidth, measure(regular, 9.5))
      : [];
    const body = wrapText(fit(truncate(item.comment.body.trim(), LIST_TEXT_MAX)), textWidth, measure(regular, 11));
    // Keep the number, the place, and the first line of the comment together.
    ensure(16 + Math.min(quote.length, 1) * 13 + 15);
    const x = margin + indent;
    page.drawCircle({ x: margin + 9, y: y - 6, size: 9, color: rgb(RED.r, RED.g, RED.b) });
    const number = String(item.n);
    const numberSize = number.length === 1 ? 10 : number.length === 2 ? 8.5 : 7;
    page.drawText(number, {
      x: margin + 9 - (DIGIT_WIDTH * numberSize * number.length) / 2,
      y: y - 6 - numberSize * 0.36,
      size: numberSize,
      font: await badgeFontOf(pdf),
      color: WHITE,
    });
    for (const line of wrapText(fit(label), textWidth, measure(bold, 10.5))) {
      page.drawText(line, { x, y: y - 10, size: 10.5, font: bold, color: INK });
      y -= 15;
    }
    y -= 1;
    for (const line of quote) {
      ensure(13);
      page.drawText(line, { x, y: y - 9.5, size: 9.5, font: regular, color: MUTED });
      y -= 13;
    }
    if (quote.length > 0) y -= 3;
    for (const line of body) {
      ensure(15);
      if (line) page.drawText(line, { x, y: y - 11, size: 11, font: regular, color: INK });
      y -= 15;
    }
    for (const reply of item.comment.thread) {
      const who = reply.name ?? (reply.author === "agent" ? null : signer);
      const name = replyAuthor(
        { ...reply, name: who, sentAt: reply.sentAt ?? 0 },
        { agent: words.agent, agentOf: words.agentOf, you: words.reply, youNotSent: words.reply },
      );
      const lines = wrapText(fit(`${name}: ${truncate(reply.body.trim(), LIST_TEXT_MAX)}`), textWidth - 12, measure(regular, 10));
      y -= 3;
      for (const line of lines) {
        ensure(14);
        if (line) page.drawText(line, { x: x + 12, y: y - 10, size: 10, font: regular, color: MUTED });
        y -= 14;
      }
    }
    y -= 12;
  }
}

const badgeFonts = new WeakMap<PDFDocument, Promise<PDFFont>>();
function badgeFontOf(pdf: PDFDocument): Promise<PDFFont> {
  let font = badgeFonts.get(pdf);
  if (!font) {
    font = pdf.embedFont(StandardFonts.HelveticaBold);
    badgeFonts.set(pdf, font);
  }
  return font;
}

/** The name tree of embedded files, flattened: [name, file spec] pairs and the arrays holding them. */
function embeddedFiles(pdf: PDFDocument): { holder: PDFArray; index: number; name: string; spec: PDFDict }[] {
  const names = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const root = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  const found: { holder: PDFArray; index: number; name: string; spec: PDFDict }[] = [];
  const visit = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 8) return;
    const pairs = node.lookupMaybe(PDFName.of("Names"), PDFArray);
    if (pairs) {
      for (let i = 0; i + 1 < pairs.size(); i += 2) {
        const key = pairs.lookup(i);
        const spec = pairs.lookupMaybe(i + 1, PDFDict);
        const name = key instanceof PDFHexString || key instanceof PDFString ? key.decodeText() : null;
        if (name && spec) found.push({ holder: pairs, index: i, name, spec });
      }
    }
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i += 1) visit(kids.lookupMaybe(i, PDFDict), depth + 1);
  };
  visit(root, 0);
  return found;
}

/** The comments an earlier export attached to this PDF, if any. */
export function readShared(pdf: PDFDocument): SharedReview | null {
  const entry = embeddedFiles(pdf).find((file) => file.name === SHARE_FILE);
  const stream = entry?.spec.lookupMaybe(PDFName.of("EF"), PDFDict)?.lookup(PDFName.of("F"));
  if (!(stream instanceof PDFRawStream)) return null;
  try {
    // Unpacked with a ceiling: a file from elsewhere could hold a tiny stream that inflates to gigabytes.
    const raw = Buffer.from(stream.getContents());
    const filter = stream.dict.lookup(PDFName.of("Filter"));
    const filters = filter instanceof PDFArray ? filter.asArray() : filter ? [filter] : [];
    let bytes: Buffer;
    if (filters.length === 0) bytes = raw;
    else if (filters.length === 1 && filters[0] === PDFName.of("FlateDecode")) {
      bytes = inflateSync(raw, { maxOutputLength: SHARED_MAX_BYTES });
    } else return null;
    if (bytes.length > SHARED_MAX_BYTES) return null;
    return parseShared(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Takes out what an earlier export added: its annotations, its list pages,
 * and its attachment. Returns that export's comments, if it had any.
 */
function removeEarlierExport(pdf: PDFDocument): SharedReview | null {
  const earlier = readShared(pdf);
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const kept = annots.asArray().filter((ref) => {
      const annot = pdf.context.lookupMaybe(ref, PDFDict);
      const name = annot?.lookup(PDFName.of("NM"));
      const text = name instanceof PDFString || name instanceof PDFHexString ? name.decodeText() : "";
      return !text.startsWith(NAME_PREFIX);
    });
    if (kept.length !== annots.size()) page.node.set(PDFName.of("Annots"), pdf.context.obj(kept));
  }
  if (earlier) {
    for (let index = pdf.getPageCount() - 1; index >= earlier.file.pages; index -= 1) pdf.removePage(index);
    for (const file of embeddedFiles(pdf).filter((entry) => entry.name === SHARE_FILE).reverse()) {
      file.holder.remove(file.index + 1);
      file.holder.remove(file.index);
    }
  }
  dropUnreachable(pdf);
  return earlier;
}

/**
 * Deletes objects nothing points to any more. pdf-lib writes every object it
 * holds, so without this the removed annotations, list pages, and attachment,
 * with the text of comments deleted since, would stay in the file's bytes.
 */
function dropUnreachable(pdf: PDFDocument): void {
  const context = pdf.context;
  const seen = new Set<string>();
  const queue: unknown[] = [context.trailerInfo.Root, context.trailerInfo.Info, context.trailerInfo.Encrypt];
  while (queue.length > 0) {
    const value = queue.pop();
    if (value instanceof PDFRef) {
      if (seen.has(value.tag)) continue;
      seen.add(value.tag);
      queue.push(context.lookup(value));
    } else if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) queue.push(entry);
    } else if (value instanceof PDFArray) {
      queue.push(...value.asArray());
    } else if (value instanceof PDFStream) {
      queue.push(value.dict);
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) context.delete(ref);
  }
}

/** Comments of an earlier export, as this bb would hold them, to carry into the next one. */
function carried(earlier: SharedReview): ReviewComment[] {
  return earlier.comments.map((shared) => ({
    id: shared.id,
    seq: 0,
    status: "draft",
    anchor: shared.anchor,
    body: shared.body,
    author: shared.author ?? UNNAMED,
    originId: shared.id,
    originFile: earlier.file.name,
    docVersion: null,
    createdAt: shared.createdAt,
    updatedAt: shared.createdAt,
    sentAt: null,
    sentThreadId: null,
    agentNote: null,
    resolvedAt: null,
    thread: shared.thread.map((reply) => ({
      id: reply.id,
      author: reply.author,
      name: reply.name ?? (reply.author === "agent" ? null : UNNAMED),
      originId: reply.id,
      body: reply.body,
      outcome: reply.outcome,
      createdAt: reply.createdAt,
      sentAt: reply.createdAt,
    })),
  }));
}

/** A PDF of page pictures, for a source that cannot be edited. Sizes are in points as shown. */
export async function pdfFromImages(pages: readonly { png: Uint8Array; width: number; height: number }[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const item of pages) {
    const image = await pdf.embedPng(item.png);
    const page = pdf.addPage([item.width, item.height]);
    page.drawImage(image, { x: 0, y: 0, width: item.width, height: item.height });
  }
  return await pdf.save();
}

/** The source PDF with the comments in it, as described at the top of this file. */
export async function annotatePdf(
  source: Uint8Array,
  comments: readonly ReviewComment[],
  options: ExportOptions,
): Promise<{ bytes: Uint8Array; count: number }> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(source, { updateMetadata: false });
  } catch (error) {
    throw new UnreadablePdfError(String(error));
  }
  if (pdf.getPageCount() === 0) throw new UnreadablePdfError("The PDF has no pages.");
  const now = options.now ?? new Date();

  // A PDF that came from an export: its comments are about the file it was made from.
  const earlier = removeEarlierExport(pdf);
  const file = earlier ? earlier.file : { name: options.name, kind: options.kind };
  // Its comments travel on unless they were imported here (then they are among `comments`).
  const known = new Set(comments.flatMap((comment) => [comment.id, comment.originId]));
  const imported = earlier?.comments.some((comment) => known.has(comment.id)) ?? true;
  const all = [...comments, ...(earlier && !imported ? carried(earlier) : [])];

  // pdf-lib keeps its page list from before removePage; the removed pages were the last ones.
  const pages = pdf.getPages().slice(0, pdf.getPageCount());
  const placed = readingOrder(all).filter((item) => !item.anchor || item.anchor.page <= pages.length);
  const annotator = new Annotator(pdf, options.signer, now);
  const frames = pages.map((page) => new PageFrame(page));

  let notes = 0;
  for (const item of placed) {
    const anchor = item.anchor;
    if (!anchor) {
      annotator.note(pages[0]!, frames[0]!, item, notes);
      notes += 1;
      continue;
    }
    const page = pages[anchor.page - 1]!;
    const frame = frames[anchor.page - 1]!;
    if (anchor.kind === "page-text") annotator.highlight(page, frame, item, anchor.rects);
    else if (anchor.kind === "page-area") annotator.box(page, frame, item, anchor.rect);
    else annotator.drawing(page, frame, item, anchor.strokes);
  }

  const shared = buildShared({
    comments: placed.map((item) => item.comment),
    file: { name: file.name, kind: file.kind, pages: pages.length },
    signer: options.signer,
    now: now.getTime(),
  });
  if (placed.length > 0) {
    await addList(pdf, placed, file.name, file.kind, options.signer, options.fonts, options.lang ?? "en");
    await pdf.attach(new TextEncoder().encode(JSON.stringify(shared)), SHARE_FILE, {
      mimeType: "application/json",
      description: "Review comments for Doc Review in bb (getbb.app)",
      creationDate: now,
      modificationDate: now,
    });
  }
  return { bytes: await pdf.save(), count: placed.length };
}
