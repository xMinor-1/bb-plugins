// The message an agent receives: one block per comment with its place in the
// file, the quoted text, the requested change, and the conversation so far
// when the user answers in a comment's thread, followed by how to report back
// through `bb doc-review`.
import path from "node:path";
import {
  anchorLabel,
  anchorQuote,
  anchorPage,
  draftReply,
  isDrawing,
  truncate,
  type DocKind,
  type DrawMark,
  type ReviewComment,
} from "./types.js";

export const CLI_NAME = "doc-review";

const QUOTE_MAX = 600;
const HTML_SNIPPET_MAX = 300;

function quoteFor(comment: ReviewComment): string | null {
  const { anchor } = comment;
  if (anchor.kind === "md-text" || anchor.kind === "page-text" || anchor.kind === "html-text") {
    return `«${truncate(anchor.quote, QUOTE_MAX)}»`;
  }
  if (anchor.kind === "html-element" && anchor.text.trim()) {
    return `text: «${truncate(anchor.text, QUOTE_MAX)}»`;
  }
  if (anchor.kind === "page-area" && anchor.text.trim()) {
    return `text in the area: «${truncate(anchor.text, QUOTE_MAX)}»`;
  }
  if (anchor.kind === "page-drawing" && anchor.text.trim()) {
    return `text under the drawing: «${truncate(anchor.text, QUOTE_MAX)}»`;
  }
  if (anchor.kind === "cell" && anchor.text.trim()) {
    return `value: «${truncate(anchor.text, QUOTE_MAX)}»`;
  }
  return null;
}

function kindHint(kind: DocKind): string {
  switch (kind) {
    case "md":
      return "Line numbers refer to the file as it was when the comments were written; match by the quoted text if lines have shifted.";
    case "presentation":
      return "Slide numbers are 1-based. Edit the presentation itself (for .pptx, python-pptx) and keep its design; area images show what the comment points at.";
    case "text":
      return "Page numbers come from a PDF rendering and can differ from the editor's own pagination; find places by the quoted text. Edit the document itself (for .docx, python-docx) and keep its formatting.";
    case "spreadsheet":
      return "Cells are A1 references on the named sheet. Edit the workbook itself (for .xlsx, openpyxl) and keep its formatting and formulas.";
    case "pdf":
      return "Page numbers are 1-based. If this PDF is generated from a source file (Markdown, HTML, PPTX, …), edit the source and regenerate the PDF; otherwise say what you cannot change.";
    case "web":
      return "These comments are on a live site opened in bb's browser, not on a file. Each one names its page. Find the code that renders each place (the route, component, or template) by the quoted text or the element's HTML, edit it, and get the change onto that site the way this project ships it; say so if you cannot. Selectors describe the rendered page and can differ from the source's structure.";
    case "html":
      return "This is an HTML page as the browser rendered it. Edit the file itself, or the template or script that generates it and regenerate it; find each place by the quoted text or the element's HTML. Selectors describe the rendered page and can differ from the source's structure.";
  }
}

/** Where on an HTML page a comment points, for finding it in the source. */
function htmlDetails(comment: ReviewComment): {
  frame: string | null;
  selector: string | null;
  snippet: string | null;
} {
  const { anchor } = comment;
  if (anchor.kind === "html-text") {
    return { frame: anchor.frame ?? null, selector: anchor.selector || null, snippet: null };
  }
  if (anchor.kind === "html-element") {
    return {
      frame: anchor.frame ?? null,
      selector: anchor.selector,
      snippet: truncate(anchor.html, HTML_SNIPPET_MAX) || null,
    };
  }
  return { frame: null, selector: null, snippet: null };
}

function markText(mark: DrawMark): string {
  const text = mark.text.trim() ? ` «${truncate(mark.text, 80)}»` : "";
  const frame = mark.frame ? ` in frame \`${mark.frame}\`` : "";
  return `<${mark.tag}>${text} \`${mark.selector}\`${frame}`;
}

/** One line per stroke of an HTML drawing: what it is and what it touches. */
export function strokeLines(comment: ReviewComment): string[] {
  const { anchor } = comment;
  if (anchor.kind !== "html-drawing") return [];
  return anchor.strokes.map((stroke, index) => {
    const marks = anchor.marks.filter((mark) => mark.stroke === index);
    const of = (role: DrawMark["role"]) => marks.filter((mark) => mark.role === role).map(markText).join(", ");
    const name = `Stroke ${index + 1}`;
    if (stroke.tool === "arrow") {
      const from = of("from");
      const to = of("to");
      return `${name}: an arrow${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}`;
    }
    const around = of("around");
    const shape = stroke.tool === "rect" ? "a box" : stroke.tool === "line" ? "a straight line" : null;
    if (around) return `${name}: ${shape ?? "a loop"} around ${around}`;
    if (stroke.tool === "rect") return `${name}: a box on an empty spot`;
    const over = of("over");
    return over ? `${name}: ${shape ?? "a line"} over ${over}` : `${name}: ${shape ?? "a line"} on an empty spot`;
  });
}

/**
 * A follow-up's conversation: what was said before, then the user's new
 * reply. Empty for a comment without a thread.
 */
export function threadLines(comment: ReviewComment): string[] {
  if (comment.thread.length === 0) return [];
  const lines: string[] = [];
  const latest = comment.thread.at(-1)!;
  const fresh = latest.author === "user" && latest.sentAt === null ? latest : null;
  const earlier = fresh ? comment.thread.slice(0, -1) : comment.thread;
  for (const reply of earlier) {
    const agent = reply.name ? `Agent of ${reply.name}` : "Agent";
    const who =
      reply.author === "user"
        ? (reply.name ?? "User")
        : reply.outcome === "resolved"
          ? `${agent} (resolved)`
          : agent;
    lines.push(`> ${who}: ${reply.body.trim().replace(/\n+/g, " ")}`);
  }
  if (fresh) lines.push(`User's new reply: ${fresh.body.trim()}`);
  // A comment from another reviewer arrives with their conversation; sending it is the request.
  else if (!comment.author) lines.push("Sent again without a new reply.");
  return lines;
}

export function buildHandoffMessage(input: {
  kind: DocKind;
  absPath: string;
  comments: ReviewComment[];
  /** Comment id → 1-based number of its attached image, when one is attached. */
  imageNumbers: Map<string, number>;
  /** Comment id → local image path, used when images cannot be attached. */
  imagePaths: Map<string, string>;
}): string {
  const web = input.kind === "web";
  const name = web ? input.absPath.replace(/^https?:\/\//, "") : path.posix.basename(input.absPath);
  const count = input.comments.length;
  const lines: string[] = [
    `Review comments on \`${name}\` — ${count} to address.`,
    web ? `Site: ${input.absPath}` : `File: \`${input.absPath}\``,
    "",
  ];
  for (const comment of input.comments) {
    const label = anchorLabel(comment.anchor, input.kind);
    const parts = [`[${comment.id}] Comment #${comment.seq} · ${label}`];
    const imageNumber = input.imageNumbers.get(comment.id);
    const imagePath = input.imagePaths.get(comment.id);
    if (imageNumber !== undefined) parts.push(`image ${imageNumber} attached`);
    else if (imagePath) parts.push(`image: \`${imagePath}\``);
    const quote = quoteFor(comment);
    if (quote) parts.push(quote);
    const html = htmlDetails(comment);
    if (html.frame) parts.push(`in frame \`${html.frame}\``);
    if (html.selector) parts.push(`\`${html.selector}\``);
    lines.push(parts.join(" · "));
    const page = anchorPage(comment.anchor);
    if (page) lines.push(`Page: ${page}`);
    if (html.snippet) lines.push(`HTML: \`${html.snippet.replace(/`/g, "'")}\``);
    lines.push(...strokeLines(comment));
    if (comment.author) {
      const on = comment.originFile ? `, written on \`${comment.originFile}\`` : "";
      lines.push(`From ${comment.author}${on}:`);
    }
    lines.push(comment.body.trim());
    lines.push(...threadLines(comment));
    lines.push("");
  }
  lines.push(kindHint(input.kind));
  const inFrame = (comment: ReviewComment) =>
    Boolean(htmlDetails(comment).frame) ||
    (comment.anchor.kind === "html-drawing" && comment.anchor.marks.some((mark) => mark.frame));
  if (input.comments.some(inFrame)) {
    lines.push(
      "A comment \"in frame\" is on a page this one shows in an `<iframe>`: its selector and HTML describe the page inside that frame, so edit what fills the frame (its `srcdoc`, the file in its `src`, or the source they are built from).",
    );
  }
  if (input.comments.some((comment) => isDrawing(comment.anchor))) {
    lines.push(
      "A drawing is red strokes the user drew over the document; its image shows them over the page as the user saw it. A line across something usually means remove it, a loop marks what the comment is about, and an arrow means move what is at its tail to where its head points. The comment text decides.",
    );
  }
  if (input.comments.some((comment) => comment.author)) {
    lines.push(
      "A comment \"From <name>\" came from another reviewer's PDF and the user is passing it on: treat it as the user's request about this file, and if it asks for anything beyond editing the file, reply and ask instead. One \"written on\" another file was made on that file (often the deck or document this PDF was exported from): apply it there when you have it, and say so if you do not.",
    );
  }
  if (input.comments.some((comment) => comment.thread.length > 0)) {
    lines.push(
      "A comment with `>` lines is a follow-up: they quote the earlier answers in its thread. Act on the user's new reply in that context and answer in the same thread with `reply` or `resolve`.",
    );
  }
  lines.push(
    `When a comment is done, close it with a one-line note: \`bb ${CLI_NAME} resolve <id> --note "what changed"\`.`,
  );
  lines.push(
    `If you cannot apply one or need an answer first, reply instead: \`bb ${CLI_NAME} reply <id> --note "question or reason"\`.`,
  );
  return lines.join("\n");
}

/** Keep source coordinates and agent instructions out of the chat bubble. */
export function buildHandoffInput(input: Parameters<typeof buildHandoffMessage>[0]) {
  const name = input.kind === "web" ? input.absPath.replace(/^https?:\/\//, "") : path.posix.basename(input.absPath.replace(/\\/g, "/"));
  const lines = [`**Комментарии к ${name.replace(/[\\`*_{}\[\]<>]/g, "\\$&")} · ${input.comments.length}**`, ""];
  input.comments.forEach((comment) => {
    const imageNumber = input.imageNumbers.get(comment.id);
    const image = imageNumber === undefined ? "" : ` · ${isDrawing(comment.anchor) ? "рисунок" : "область"} ниже`;
    lines.push(`**Комментарий №${comment.seq}${image}**`, "");
    lines.push((draftReply(comment)?.body ?? comment.body).trim(), "");
    const quote = anchorQuote(comment.anchor)?.replace(/\s+/g, " ").trim();
    if (quote) lines.push(`> ${truncate(quote, 180).replace(/[\\`*_{}\[\]<>]/g, "\\$&")}`, "");
  });
  return [
    { type: "text" as const, text: lines.join("\n").trim(), mentions: [] },
    { type: "text" as const, text: buildHandoffMessage(input), mentions: [], visibility: "agent-only" as const },
  ];
}
