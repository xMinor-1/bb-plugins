// HTML view: the page renders live in a sandboxed frame (opaque origin, so its
// scripts cannot reach bb), and the bridge the server injects into it
// (src/html-bridge.ts) reports selections and picked elements and paints the
// comments sent to it. In Text mode a selection gets a Comment button; in
// Element mode a click on any block, button, or picture comments on it; in
// Draw mode the strokes drawn over the page become one comment, sent with the
// page as it looks, so the server can photograph it for the agent.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { Capture } from "../src/contract";
import { HTML_SANDBOX, type Anchor, type DrawMark, type DrawTool, type ReviewComment, type Stroke } from "../src/types";
import type { Point } from "./markdown-doc";
import type { PageMode } from "./pages-doc";
import { DrawingBar } from "./drawing-bar";
import { SelectionMenu } from "./selection-menu";

interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type HtmlAnchor = Extract<Anchor, { kind: "html-text" | "html-element" | "html-drawing" }>;

function isHtmlAnchor(anchor: Anchor | null | undefined): anchor is HtmlAnchor {
  return anchor?.kind === "html-text" || anchor?.kind === "html-element" || anchor?.kind === "html-drawing";
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readStrokes(value: unknown): Stroke[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 60) return null;
  const strokes: Stroke[] = [];
  for (const raw of value as unknown[]) {
    const item = raw as Record<string, unknown> | null;
    const points = item?.points;
    if (!item || (item.tool !== "pen" && item.tool !== "arrow") || !Array.isArray(points)) return null;
    if (points.length < 2 || points.length > 4000 || points.length % 2 !== 0 || !points.every(finite)) return null;
    strokes.push({ tool: item.tool, points: points as number[] });
  }
  return strokes;
}

function readMarks(value: unknown): DrawMark[] {
  if (!Array.isArray(value)) return [];
  const marks: DrawMark[] = [];
  for (const raw of (value as unknown[]).slice(0, 180)) {
    const item = raw as Record<string, unknown> | null;
    const role = item?.role;
    const selector = text(item?.selector, 1000);
    const tag = text(item?.tag, 40);
    if (!item || !finite(item.stroke) || !selector || !tag) continue;
    if (role !== "over" && role !== "around" && role !== "from" && role !== "to") continue;
    const frame = text(item.frame, 1000);
    marks.push({ stroke: Math.max(0, Math.floor(item.stroke)), role, selector, tag, text: text(item.text, 400) ?? "", ...(frame ? { frame } : {}) });
  }
  return marks;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

/** Messages come from a page we do not control: keep only well-formed anchors. */
function readAnchor(value: unknown): HtmlAnchor | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  // Set when the place is inside a frame the page shows.
  const frame = text(raw.frame, 1000);
  const where = frame ? { frame } : {};
  if (raw.kind === "html-text") {
    const quote = text(raw.quote, 4000);
    if (!quote?.trim()) return null;
    return {
      kind: "html-text",
      quote,
      prefix: text(raw.prefix, 200) ?? "",
      suffix: text(raw.suffix, 200) ?? "",
      selector: text(raw.selector, 1000) ?? "",
      ...where,
    };
  }
  if (raw.kind === "html-drawing") {
    const strokes = readStrokes(raw.strokes);
    const viewport = raw.viewport as Record<string, unknown> | null;
    if (!strokes || !viewport || !finite(viewport.w) || !finite(viewport.h)) return null;
    const w = Math.min(20000, Math.max(1, viewport.w));
    const h = Math.min(20000, Math.max(1, viewport.h));
    return { kind: "html-drawing", strokes, viewport: { w, h }, marks: readMarks(raw.marks) };
  }
  if (raw.kind === "html-element") {
    const selector = text(raw.selector, 1000);
    const tag = text(raw.tag, 40);
    if (!selector || !tag) return null;
    return {
      kind: "html-element",
      selector,
      tag,
      text: text(raw.text, 4000) ?? "",
      html: text(raw.html, 2000) ?? "",
      ...where,
    };
  }
  return null;
}

function readRect(value: unknown): FrameRect | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const numbers = [raw.x, raw.y, raw.w, raw.h];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { x: raw.x as number, y: raw.y as number, w: raw.w as number, h: raw.h as number };
}

const COMPOSER_WIDTH = 352;
const COMPOSER_HEIGHT = 170;
/** How long a loaded page has to answer before the panel decides a link took the frame elsewhere. */
const ANSWER_MS = 2500;
/** The page as it looked is sent for the agent's picture up to this size. */
const SNAPSHOT_MAX = 24 * 1024 * 1024;

// What the bridge needs to know; sent when it announces itself and on change.
function modeMessage(mode: PageMode, tool: DrawTool) {
  return { type: "mode", mode: mode === "area" ? "element" : mode, tool };
}

function readSnapshot(value: unknown): Capture | undefined {
  const raw = value as Record<string, unknown> | null;
  const scroll = raw?.scroll as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw.html !== "string" || !raw.html || raw.html.length > SNAPSHOT_MAX) return undefined;
  if (!scroll || !finite(scroll.x) || !finite(scroll.y)) return undefined;
  return { kind: "html", html: raw.html, scroll: { x: scroll.x, y: scroll.y } };
}

function commentsMessage(comments: ReviewComment[], activeId: string | null) {
  return {
    type: "comments",
    items: comments
      .filter((comment) => isHtmlAnchor(comment.anchor) && (comment.status !== "resolved" || comment.id === activeId))
      .map((comment) => ({ id: comment.id, seq: comment.seq, active: comment.id === activeId, anchor: comment.anchor })),
  };
}

function pendingMessage(anchor: Anchor | null) {
  return { type: "pending", anchor: isHtmlAnchor(anchor) ? anchor : null };
}

export function HtmlDoc({
  url,
  name,
  mode,
  tool,
  drawingsSaved,
  comments,
  activeId,
  scrollRequest,
  pendingAnchor,
  composer,
  composerPoint,
  onRequestComment,
  onSelectComment,
  onDetached,
}: {
  url: string;
  name: string;
  mode: PageMode;
  tool: DrawTool;
  /** Counts saved drawings: each one clears the strokes waiting on the page. */
  drawingsSaved: number;
  comments: ReviewComment[];
  activeId: string | null;
  scrollRequest: number;
  pendingAnchor: Anchor | null;
  composer: ReactNode;
  composerPoint: Point | null;
  onRequestComment: (anchor: Anchor, point: Point, capture?: Capture) => void;
  onSelectComment: (id: string) => void;
  /** Comments whose text or element the page no longer has. */
  onDetached: (ids: Set<string>) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [reloads, setReloads] = useState(0);
  // Readiness belongs to one frame: a new URL or a reload starts over.
  const frameKey = `${url}#${reloads}`;
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [awayKey, setAwayKey] = useState<string | null>(null);
  const ready = readyKey === frameKey;
  const away = awayKey === frameKey;
  const [button, setButton] = useState<{ anchor: HtmlAnchor; point: Point } | null>(null);
  const [menu, setMenu] = useState<{ top: number; left: number; anchor: HtmlAnchor } | null>(null);
  /** Strokes drawn and not commented on yet, and where their bar goes. */
  const [sketch, setSketch] = useState<{ count: number; point: Point } | null>(null);
  /** The bridge the panel last sent its state to. */
  const bridge = useRef({ key: "", session: "" });
  /** Loads of the frame, and the last one a bridge answered. */
  const loads = useRef({ count: 0, answered: 0 });
  const hideButton = useRef(0);

  const post = useCallback((message: Record<string, unknown>) => {
    // The frame's origin is opaque, so "*" is the only target that reaches it.
    frame.current?.contentWindow?.postMessage({ ...message, docReview: 1 }, "*");
  }, []);

  /** A point in the root under the frame's rect, kept inside the view. */
  const pointFor = useCallback((rect: FrameRect, width = 140): Point => {
    const element = root.current;
    const box = frame.current?.getBoundingClientRect();
    const rootBox = element?.getBoundingClientRect();
    const offsetX = box && rootBox ? box.left - rootBox.left : 0;
    const offsetY = box && rootBox ? box.top - rootBox.top : 0;
    const maxLeft = (element?.clientWidth ?? 800) - width - 8;
    const maxTop = (element?.clientHeight ?? 600) - 40;
    return {
      top: Math.max(8, Math.min(offsetY + rect.y + rect.h + 6, maxTop)),
      left: Math.max(8, Math.min(offsetX + rect.x + rect.w - 40, maxLeft)),
    };
  }, []);

  const commentOn = useCallback(
    (anchor: HtmlAnchor, point: Point) => {
      window.clearTimeout(hideButton.current);
      setButton(null);
      setMenu(null);
      post({ type: "clear-selection" });
      onRequestComment(anchor, point);
    },
    [onRequestComment, post],
  );

  // Messages from the bridge.
  const latest = useRef({ commentOn, onRequestComment, onSelectComment, onDetached, pointFor, button, mode, tool, comments, activeId, pendingAnchor });
  latest.current = { commentOn, onRequestComment, onSelectComment, onDetached, pointFor, button, mode, tool, comments, activeId, pendingAnchor };
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.docReview !== 1) return;
      const { commentOn, onSelectComment, onDetached, pointFor, button } = latest.current;
      switch (data.type) {
        case "ready": {
          // A bridge announces itself when its page starts and answers each
          // hello; a new session in the same frame is the page loading again.
          const key = frame.current.dataset.key ?? "";
          const session = typeof data.session === "string" ? data.session : "";
          loads.current.answered = loads.current.count;
          setAwayKey(null);
          if (bridge.current.key !== key) {
            bridge.current = { key, session };
            setReadyKey(key);
          } else if (bridge.current.session !== session) {
            bridge.current = { key, session };
            const { mode, tool, comments, activeId, pendingAnchor } = latest.current;
            post(modeMessage(mode, tool));
            post(commentsMessage(comments, activeId));
            post(pendingMessage(pendingAnchor));
          }
          break;
        }
        case "selection": {
          const anchor = readAnchor(data.anchor);
          const rect = readRect(data.rect);
          window.clearTimeout(hideButton.current);
          if (anchor && rect) setButton({ anchor, point: pointFor(rect, 110) });
          // A tap on the button can clear the selection before the tap lands.
          else hideButton.current = window.setTimeout(() => setButton(null), 350);
          break;
        }
        case "element": {
          const anchor = readAnchor(data.anchor);
          const rect = readRect(data.rect);
          if (anchor && rect) commentOn(anchor, pointFor(rect, COMPOSER_WIDTH));
          break;
        }
        case "shortcut": {
          const anchor = readAnchor(data.anchor);
          const rect = readRect(data.rect);
          if (anchor && rect) commentOn(anchor, pointFor(rect, COMPOSER_WIDTH));
          break;
        }
        case "contextmenu": {
          const anchor = readAnchor(data.anchor);
          const x = typeof data.x === "number" ? data.x : null;
          const y = typeof data.y === "number" ? data.y : null;
          if (anchor && x !== null && y !== null) {
            const point = pointFor({ x, y, w: 0, h: 0 }, 190);
            setMenu({ top: point.top - 6, left: point.left + 40, anchor });
          }
          break;
        }
        case "sketch": {
          const rect = readRect(data.rect);
          const count = typeof data.count === "number" ? data.count : 0;
          setSketch(count > 0 && rect ? { count, point: pointFor(rect, 240) } : null);
          break;
        }
        case "drawing": {
          const anchor = readAnchor(data.anchor);
          const rect = readRect(data.rect);
          if (anchor?.kind === "html-drawing" && rect) {
            latest.current.onRequestComment(anchor, pointFor(rect, COMPOSER_WIDTH), readSnapshot(data.snapshot));
          }
          break;
        }
        case "select":
          if (typeof data.id === "string") onSelectComment(data.id);
          break;
        case "resolved":
          if (Array.isArray(data.missing)) {
            onDetached(new Set(data.missing.filter((id): id is string => typeof id === "string")));
          }
          break;
        case "escape":
          setMenu(null);
          if (button) setButton(null);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    // The page may have announced itself before this listener existed.
    post({ type: "hello" });
    return () => window.removeEventListener("message", onMessage);
  }, [post]);

  useEffect(() => () => window.clearTimeout(hideButton.current), []);

  // A new URL (the file changed) or a reload starts the page over.
  useEffect(() => {
    setButton(null);
    setMenu(null);
    setSketch(null);
  }, [frameKey]);

  const onLoad = () => {
    // Our page has a bridge that answers; silence means a link took the
    // frame to another page.
    const key = frameKey;
    const load = (loads.current.count += 1);
    post({ type: "hello" });
    window.setTimeout(() => {
      if (loads.current.answered < load && loads.current.count === load) setAwayKey(key);
    }, ANSWER_MS);
  };

  // Keep the bridge in step with the panel.
  useEffect(() => {
    if (ready) post(modeMessage(mode, tool));
    if (mode !== "text") setButton(null);
  }, [ready, mode, tool, post]);

  useEffect(() => {
    if (ready && drawingsSaved) post({ type: "sketch-clear" });
  }, [drawingsSaved]); // eslint-disable-line react-hooks/exhaustive-deps

  // Undo reaches the page from the panel too, when the focus is out here.
  useEffect(() => {
    if (mode !== "draw" || composer) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.code === "KeyZ") {
        event.preventDefault();
        post({ type: "sketch-undo" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, composer, post]);

  useEffect(() => {
    if (ready) post(commentsMessage(comments, activeId));
  }, [ready, comments, activeId, post]);

  useEffect(() => {
    if (ready) post(pendingMessage(pendingAnchor));
  }, [ready, pendingAnchor, post]);

  useEffect(() => {
    if (ready && scrollRequest && activeId) post({ type: "reveal", id: activeId });
  }, [scrollRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const composerTop = composerPoint
    ? Math.max(8, Math.min(composerPoint.top, (root.current?.clientHeight ?? 600) - COMPOSER_HEIGHT - 8))
    : 0;
  const composerWidth = Math.max(200, Math.min(COMPOSER_WIDTH, (root.current?.clientWidth ?? 400) - 16));

  return (
    <div ref={root} className="relative h-full w-full overflow-hidden bg-white">
      <iframe
        key={frameKey}
        ref={frame}
        data-key={frameKey}
        src={url}
        title={name}
        sandbox={HTML_SANDBOX}
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
      {!ready && !away ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
          <Icon name="Loading" className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {away ? (
        <div className="absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-3 border-b border-border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-sm">
          <span>A link opened another page; comments work on {name}.</span>
          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setReloads((value) => value + 1)}>
            Back to {name}
          </Button>
        </div>
      ) : null}
      {menu ? (
        <SelectionMenu
          top={menu.top}
          left={menu.left}
          quote={menu.anchor.kind === "html-text" ? menu.anchor.quote : ""}
          onClose={() => setMenu(null)}
          onComment={() => commentOn(menu.anchor, { top: menu.top + 4, left: menu.left })}
        />
      ) : null}
      {button && !composer && mode === "text" ? (
        <button
          type="button"
          className="absolute z-40 inline-flex items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent"
          style={{ top: button.point.top, left: button.point.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commentOn(button.anchor, button.point)}
        >
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Comment
        </button>
      ) : null}
      {sketch && !composer && mode === "draw" ? (
        <DrawingBar
          point={sketch.point}
          onComment={() => post({ type: "sketch-done" })}
          onUndo={() => post({ type: "sketch-undo" })}
          onClear={() => post({ type: "sketch-clear" })}
        />
      ) : null}
      {composer && composerPoint ? (
        <div
          className="absolute z-50"
          style={{
            top: composerTop,
            left: Math.max(8, Math.min(composerPoint.left, (root.current?.clientWidth ?? 400) - composerWidth - 8)),
            width: composerWidth,
          }}
        >
          {composer}
        </div>
      ) : null}
    </div>
  );
}
