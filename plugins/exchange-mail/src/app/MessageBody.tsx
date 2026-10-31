// The text of a message. Plain text shows its links as links. HTML mail is
// shown the safe way: sanitized, in a frame where no script runs and nothing
// loads from the internet until the person asks for the pictures. Pictures the
// message carries itself (cid:) are shown inside the text.
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { textParts } from "../shared/mail-text";
import { safeHref } from "../shared/mail-text";
import { defineMessages, useMessages } from "@/lib/i18n";

const texts = defineMessages(
  {
    remoteHidden: (n: number) => `${n === 1 ? "A picture" : `${n} pictures`} from the internet ${n === 1 ? "is" : "are"} hidden: loading them tells the sender you opened the message.`,
    showPictures: "Show pictures",
    asText: "Show as plain text",
    asHtml: "Show formatted",
    empty: "(empty)",
    frameTitle: "Message text",
  },
  {
    remoteHidden: (n) => `Картинки из интернета скрыты (${n}): если их загрузить, отправитель узнает, что вы открыли письмо.`,
    showPictures: "Показать картинки",
    asText: "Показать как текст",
    asHtml: "Показать с оформлением",
    empty: "(пусто)",
    frameTitle: "Текст письма",
  },
);

export function MessageText({ text }: { text: string }) {
  const parts = useMemo(() => textParts(text), [text]);
  return (
    <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-4 text-sm leading-relaxed">
      {parts.map((part, n) =>
        part.kind === "text" ? (
          <span key={n}>{part.text}</span>
        ) : (
          <a key={n} href={part.href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
            {part.label}
          </a>
        ),
      )}
    </div>
  );
}

const RASTER = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i;
const DROPPED_TAGS = ["script", "form", "area", "map", "input", "button", "select", "textarea", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta", "base", "audio", "video", "source", "track", "portal", "svg", "math"];

const cidKey = (value: string) => value.replace(/^cid:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();

/**
 * The message's HTML, made safe to show: no scripts, forms, frames or plugins,
 * only web and mail links, pictures from the message itself, and pictures from
 * the internet only when `remote` is on. Exported for tests.
 */
export function sanitizeMail(html: string, options: { images: ReadonlyMap<string, string>; remote: boolean }): { head: string; body: string; blocked: number } {
  const purify = DOMPurify(window);
  let blocked = 0;
  purify.addHook("afterSanitizeAttributes", (node) => {
    const element = node as Element;
    if (element.hasAttribute("background")) element.removeAttribute("background");
    if (element.tagName === "A") {
      const href = safeHref(element.getAttribute("href") ?? "");
      if (href) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      } else element.removeAttribute("href");
    } else if (element.hasAttribute("href")) element.removeAttribute("href");
    if (element.tagName === "IMG") {
      const src = (element.getAttribute("src") ?? "").trim();
      if (/^cid:/i.test(src)) {
        const found = options.images.get(cidKey(src));
        if (found) element.setAttribute("src", found);
        else element.removeAttribute("src");
      } else if (/^https?:\/\//i.test(src)) {
        if (!options.remote) {
          element.removeAttribute("src");
          blocked++;
        }
      } else if (!RASTER.test(src)) element.removeAttribute("src");
    }
  });
  const root = purify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS: DROPPED_TAGS,
    FORBID_ATTR: ["srcset", "action", "formaction", "ping", "usemap"],
    ALLOW_DATA_ATTR: false,
  }) as HTMLElement;
  const head = Array.from(root.querySelectorAll("style")).map((style) => style.outerHTML).join("");
  root.querySelectorAll("style").forEach((style) => style.remove());
  const body = root.querySelector("body")?.innerHTML ?? root.innerHTML;
  return { head, body, blocked };
}

/** The frame's document. Its own policy forbids scripts and any load but the pictures allowed here. */
export function frameDocument(parts: { head: string; body: string }, remote: boolean): string {
  const policy = `default-src 'none'; img-src data:${remote ? " https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank">` +
    `<style>html,body{margin:0;background:#fff;color:#111}body{padding:16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>` +
    `${parts.head}</head><body>${parts.body}</body></html>`
  );
}

export function HtmlBody({ html, images }: { html: string; images: ReadonlyMap<string, string> }) {
  const t = useMessages(texts);
  const [remote, setRemote] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const clean = useMemo(() => sanitizeMail(html, { images, remote }), [html, images, remote]);
  const doc = useMemo(() => frameDocument(clean, remote), [clean, remote]);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | null = null;
    // Same origin without scripts: the panel measures the text to size the frame.
    const measure = () => {
      const inner = element.contentDocument?.documentElement;
      if (inner) setHeight(Math.min(Math.max(inner.scrollHeight, 80), 20_000));
    };
    const loaded = () => {
      measure();
      const body = element.contentDocument?.body;
      if (body && typeof ResizeObserver !== "undefined") {
        observer?.disconnect();
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    element.addEventListener("load", loaded);
    return () => {
      element.removeEventListener("load", loaded);
      observer?.disconnect();
    };
  }, [doc]);

  return (
    <div className="space-y-2">
      {clean.blocked > 0 && !remote ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <span>{t.remoteHidden(clean.blocked)}</span>
          <button type="button" className="underline underline-offset-2" onClick={() => setRemote(true)}>
            {t.showPictures}
          </button>
        </div>
      ) : null}
      <iframe
        ref={frame}
        title={t.frameTitle}
        // No allow-scripts, no allow-forms: the frame shares the panel's origin only so its height can be read.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        style={{ height }}
        className="block w-full rounded-lg border border-border bg-white"
      />
    </div>
  );
}

export function MessageBody({ text, html, images }: { text: string; html: string | null; images: ReadonlyMap<string, string> }) {
  const t = useMessages(texts);
  const [plain, setPlain] = useState(false);
  if (!html) return text ? <MessageText text={text} /> : <MessageText text={t.empty} />;
  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setPlain((v) => !v)}>
          {plain ? t.asHtml : t.asText}
        </button>
      </div>
      {plain ? <MessageText text={text || t.empty} /> : <HtmlBody html={html} images={images} />}
    </div>
  );
}
