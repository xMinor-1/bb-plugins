// Shared, dependency-free types and helpers. Both server.ts and app.tsx import
// this module, so it must stay free of Node and zod imports.

import { documentFamily, extensionOf } from "../lib/formats.js";

/**
 * - `md`: Markdown, rendered as text.
 * - `pdf`: pages as they are.
 * - `text` (Word, ODT, RTF) and `presentation` (PowerPoint, ODP): converted
 *   to PDF by LibreOffice, then shown as pages.
 * - `spreadsheet` (Excel, ODS): a grid of cells.
 * - `html`: a web page, rendered live in a sandboxed frame.
 * - `web`: a live site opened in bb's own browser, one document per origin;
 *   its `absPath` is the origin and each comment names its page.
 */
export type DocKind = "md" | "pdf" | "text" | "presentation" | "spreadsheet" | "html" | "web";

/** The `sandbox` flags for an HTML page's frame, also sent as a CSP header with the page. */
export const HTML_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** Kinds shown as rendered pages. */
export type PagedKind = "pdf" | "text" | "presentation";

export function isPaged(kind: DocKind): kind is PagedKind {
  return kind === "pdf" || kind === "text" || kind === "presentation";
}

/** A rectangle in page coordinates normalized to 0..1 of the page size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Drawing tools, in the order the toolbar shows them. */
export const DRAW_TOOLS = ["pen", "line", "arrow", "rect"] as const;

export type DrawTool = (typeof DRAW_TOOLS)[number];

export function isDrawTool(value: unknown): value is DrawTool {
  return (DRAW_TOOLS as readonly unknown[]).includes(value);
}

/**
 * One stroke of a drawing: a freehand line (`pen`); or a shape set by two
 * points, its first and its last: a straight `line`, an `arrow` pointing at
 * the last point, or a `rect` with those two corners. Points are flat
 * `[x0, y0, x1, y1, …]`: on a page, fractions of the page size; on an HTML
 * page, CSS pixels from the top left of the page as it scrolls.
 */
export interface Stroke {
  tool: DrawTool;
  points: number[];
}

/**
 * What a stroke on an HTML page touches:
 * - `over`: a line drawn across the element (crossed out, underlined).
 * - `around`: the largest element inside a closed loop.
 * - `from` and `to`: the elements at an arrow's tail and head.
 */
export interface DrawMark {
  /** 0-based index of the stroke in the drawing. */
  stroke: number;
  role: "over" | "around" | "from" | "to";
  selector: string;
  tag: string;
  /** The element's visible text, shortened. */
  text: string;
  /** Set when the element is inside a frame, as for `html-text`. */
  frame?: string;
}

/**
 * Where a comment points.
 * - `doc`: the whole document.
 * - `md-text`: selected text in a Markdown file, with its source line range.
 * - `page-text`: selected text on a PDF page or PPTX slide (1-based page).
 * - `page-area`: a drawn rectangle on a page, with the text found inside it.
 * - `cell`: a cell or range in a workbook.
 * - `html-text`: selected text on an HTML page.
 * - `html-element`: an element picked on an HTML page.
 * - `page-drawing`: strokes drawn on a page, with the text under them.
 * - `html-drawing`: strokes drawn over an HTML page, with the elements they touch.
 */
export type Anchor =
  | { kind: "doc" }
  | {
      kind: "md-text";
      quote: string;
      prefix: string;
      suffix: string;
      startLine: number;
      endLine: number;
    }
  | { kind: "page-text"; page: number; quote: string; rects: Rect[] }
  | { kind: "page-area"; page: number; rect: Rect; text: string }
  | {
      kind: "cell";
      /** Sheet name as the workbook shows it, and its 0-based position. */
      sheet: string;
      sheetIndex: number;
      /** A1-style cell or range, like "B3" or "B3:D7". */
      ref: string;
      /** The displayed values in the range, for context. */
      text: string;
    }
  | {
      kind: "html-text";
      quote: string;
      prefix: string;
      suffix: string;
      /** CSS path of the element that holds the selection, as the page renders it. */
      selector: string;
      /**
       * Set when the text is inside a frame the page shows (an `<iframe
       * srcdoc>` preview, say): the frame element's CSS path, outermost frame
       * first, joined by " >>> ". The selector then describes the page inside.
       */
      frame?: string;
      /** On a live site: the page the comment was left on. */
      url?: string;
    }
  | {
      kind: "html-element";
      /** CSS path of the element, as the page renders it. */
      selector: string;
      /** Tag name in lower case. */
      tag: string;
      /** The element's visible text, trimmed. */
      text: string;
      /** The start of its outer HTML, for finding it in the source. */
      html: string;
      /** Set when the element is inside a frame, as for `html-text`. */
      frame?: string;
      /** On a live site: the page the comment was left on. */
      url?: string;
    }
  | { kind: "page-drawing"; page: number; strokes: Stroke[]; text: string }
  | {
      kind: "html-drawing";
      strokes: Stroke[];
      /** The page's viewport when it was drawn on: the layout the strokes match. */
      viewport: { w: number; h: number };
      marks: DrawMark[];
      /** On a live site: the page the comment was left on. */
      url?: string;
    };

/**
 * - `draft`: written, not handed to an agent yet.
 * - `sent`: handed to an agent, waiting for the fix.
 * - `replied`: the agent answered without fixing (a question or a refusal).
 * - `resolved`: the agent fixed it and left a note.
 */
export type CommentStatus = "draft" | "sent" | "replied" | "resolved";

/**
 * One message in a comment's thread after the comment itself: the agent's
 * answer or note, or the user's reply to it.
 */
export interface CommentReply {
  id: string;
  author: "user" | "agent";
  /**
   * Set when the reply came from another reviewer's file: their name, or for
   * an agent, the reviewer whose agent wrote it. Null for this bb's own.
   */
  name: string | null;
  /** The reply's id in the review it was imported from. */
  originId: string | null;
  body: string;
  /** For the agent: whether it answered (`replied`) or closed the comment (`resolved`). */
  outcome: "replied" | "resolved" | null;
  createdAt: number;
  /** When a user reply went to the agent; null while it is a draft. Agent notes carry their time. */
  sentAt: number | null;
}

export interface ReviewComment {
  id: string;
  /** Display number within the document: #1, #2, … */
  seq: number;
  status: CommentStatus;
  anchor: Anchor;
  body: string;
  /** Who wrote it, when it came from another reviewer's file; null for this bb's user. */
  author: string | null;
  /** The comment's id in the review it was imported from. */
  originId: string | null;
  /** The file it was written on, when that is another file (an imported PDF's source). */
  originFile: string | null;
  /** Document version the comment was written against. */
  docVersion: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  sentThreadId: string | null;
  /** The agent's latest note: what it changed, or its question. */
  agentNote: string | null;
  resolvedAt: number | null;
  /** Messages after the comment, oldest first; an unsent reply of the user comes last. */
  thread: CommentReply[];
  /** The picture a drawing went with, served to the panel; absent without one. */
  imageUrl?: string;
}

export interface ReviewDoc {
  id: string;
  kind: DocKind;
  name: string;
  absPath: string;
  /** Null when the file lives on the bb server's own machine. */
  hostId: string | null;
  version: string;
  htmlUrl: string | null;
}

export interface PageInfo {
  /** 1-based page (or slide) number. */
  n: number;
  /** Page size in PDF points. */
  width: number;
  height: number;
  /** Image URL for the rendered page. */
  url: string;
}

/**
 * Widths, in pixels, a page image is rendered at. The panel asks for the
 * smallest one that covers the page at its zoom on the screen's pixel density.
 */
export const PAGE_WIDTHS = [600, 900, 1200, 1600, 2400, 3200, 4800, 6400] as const;

/** The rendered width to ask for when a page shows `cssWidth` CSS pixels wide. */
export function pageImageWidth(cssWidth: number, pixelRatio: number): number {
  const wanted = cssWidth * Math.max(1, pixelRatio);
  // A tenth of slack keeps a page just past a step on the smaller image.
  return PAGE_WIDTHS.find((width) => width >= wanted * 0.9) ?? PAGE_WIDTHS[PAGE_WIDTHS.length - 1]!;
}

/** One word with its box normalized to the page: [x0, y0, x1, y1, text]. */
export type PageWord = [number, number, number, number, string];

export interface PageText {
  n: number;
  lines: PageWord[][];
}

export const MARKDOWN_EXTENSIONS = ["md", "markdown"] as const;
export const HTML_EXTENSIONS = ["html", "htm"] as const;

export function docKindFor(path: string): DocKind | null {
  const extension = extensionOf(path);
  if ((MARKDOWN_EXTENSIONS as readonly string[]).includes(extension)) return "md";
  if ((HTML_EXTENSIONS as readonly string[]).includes(extension)) return "html";
  return documentFamily(path);
}

/** "Slide" for decks, "Page" for everything else. */
export function pageNoun(kind: DocKind): "Slide" | "Page" {
  return kind === "presentation" ? "Slide" : "Page";
}

/** A short human label for where a comment points. */
export function anchorLabel(anchor: Anchor, kind: DocKind): string {
  const label = placeLabel(anchor, kind);
  // On a live site the page tells comments apart as much as the place does.
  const page = kind === "web" ? anchorPage(anchor) : null;
  if (!page) return label;
  try {
    return `${label}, ${new URL(page).pathname}`;
  } catch {
    return label;
  }
}

function placeLabel(anchor: Anchor, kind: DocKind): string {
  switch (anchor.kind) {
    case "doc":
      return "Whole document";
    case "md-text":
      return anchor.startLine === anchor.endLine
        ? `Line ${anchor.startLine}`
        : `Lines ${anchor.startLine}–${anchor.endLine}`;
    case "page-text":
      return `${pageNoun(kind)} ${anchor.page}`;
    case "page-area":
      return `${pageNoun(kind)} ${anchor.page}, area`;
    case "cell":
      return `${anchor.sheet}!${anchor.ref}`;
    case "html-text":
      return "Text";
    case "html-element":
      return `Element <${anchor.tag}>`;
    case "page-drawing":
      return `${pageNoun(kind)} ${anchor.page}, drawing`;
    case "html-drawing":
      return "Drawing";
  }
}

/** The quoted text a comment points at, if any. */
export function anchorQuote(anchor: Anchor): string | null {
  switch (anchor.kind) {
    case "md-text":
    case "page-text":
      return anchor.quote;
    case "html-text":
      return anchor.quote;
    case "page-area":
    case "page-drawing":
    case "cell":
    case "html-element":
      return anchor.text || null;
    case "html-drawing":
    case "doc":
      return null;
  }
}

/** Collapse whitespace so quotes compare across line wrapping. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isDrawing(anchor: Anchor): anchor is Extract<Anchor, { kind: "page-drawing" | "html-drawing" }> {
  return anchor.kind === "page-drawing" || anchor.kind === "html-drawing";
}

/** The user's reply waiting to be sent, if any. */
export function draftReply(comment: ReviewComment): CommentReply | null {
  const last = comment.thread[comment.thread.length - 1];
  return last && last.author === "user" && last.sentAt === null ? last : null;
}

export type PageAnchor = Extract<Anchor, { kind: "page-text" | "page-area" | "page-drawing" }>;

export function isPageAnchor(anchor: Anchor): anchor is PageAnchor {
  return anchor.kind === "page-text" || anchor.kind === "page-area" || anchor.kind === "page-drawing";
}

/**
 * Whether other reviewers are in on a comment: they wrote it, or answered it
 * in a PDF that came back. Such a comment takes replies even as a draft.
 */
export function sharedWithOthers(comment: ReviewComment): boolean {
  return comment.author !== null || comment.thread.some((reply) => reply.name !== null);
}

/** Who wrote a reply, as the comment list and the agent read it. */
export function replyAuthor(reply: CommentReply): string {
  if (reply.author === "agent") return reply.name ? `${reply.name}'s agent` : "Agent";
  if (reply.name) return reply.name;
  return reply.sentAt === null ? "You, not sent" : "You";
}

/** The page of a live site a comment was left on, if it has one. */
export function anchorPage(anchor: Anchor): string | null {
  return "url" in anchor && typeof anchor.url === "string" ? anchor.url : null;
}

/** A live site's pages are the same page whatever their query or hash says. */
export function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";
    return left.origin === right.origin && path(left) === path(right);
  } catch {
    return false;
  }
}

export function truncate(text: string, max: number): string {
  const flat = squash(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
