// The Review button beside the address bar of bb's own browser (desktop app
// only: elsewhere bb gives plugins no access to the page). It puts the review
// controls into the live page (src/web-ui.ts with the bridge), keeps them fed
// with the site's comments, and does what they ask: save a comment, reply,
// delete, take a picture of the tab for a drawing, and send the drafts to the
// thread that owns the tab. A site is one document; each comment remembers
// its page, and a page shows the comments left on it.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  type ExperimentalPluginBrowserPage,
  type ExperimentalPluginBrowserToolbarActionProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { defineMessages, messagesNow, useMessages } from "@/lib/i18n";
import { BRIDGE_SCRIPT } from "../src/html-bridge";
import { WEB_UI_SCRIPT, WEB_UI_TEXT } from "../src/web-ui";
import { anchorPage, samePage, type ReviewComment } from "../src/types";
import { readAnchor } from "./html-doc";
import { countWords } from "./labels";
import { errorText, useReviewRpc } from "./use-review";

/** The controls drawn inside the page (src/web-ui.ts). */
const pageText = defineMessages(WEB_UI_TEXT, {
  replyPlaceholder: "Ответьте агенту",
  statusDraft: "Черновик",
  statusSent: "Отправлен",
  statusReplied: "Есть ответ",
  statusResolved: "Готово",
  sentToChat: "Отправлено в тред",
  element: "Элемент <{tag}>",
  drawing: "Рисунок",
  text: "Текст",
  page: "Страница",
  cancel: "Отмена",
  modeText: "Текст",
  modeTextTitle: "Выделите текст, чтобы прокомментировать его",
  modeElement: "Элемент",
  modeElementTitle: "Нажмите на блок, кнопку или картинку, чтобы прокомментировать",
  modeDraw: "Рисовать",
  modeDrawTitle: "Рисуйте поверх страницы, затем прокомментируйте рисунок",
  pen: "Перо",
  line: "Линия",
  arrow: "Стрелка",
  box: "Рамка",
  comments: "Комментарии",
  sending: "Отправляем…",
  send: "Отправить",
  sendTitle: "Отправить в тред все черновики этого сайта",
  stop: "Закончить ревью страницы",
  placeholder: "Что здесь поменять?",
  comment: "Комментировать",
  agent: "Агент",
  you: "Вы",
  youNotSent: "Вы, не отправлено",
  discardReply: "Удалить ответ",
  delete: "Удалить",
  deleteComment: "Удалить комментарий",
  drawingPicture: "Рисунок со снимком страницы",
  elementGone: "Этого элемента сейчас нет на странице.",
  quoteGone: "Процитированного текста сейчас нет на странице.",
  reply: "Ответить",
  empty: "На этой странице пока нет комментариев. Выделите текст или переключитесь на «Элемент» или «Рисовать».",
  listTitle: "Комментарии к странице",
  close: "Закрыть",
  undo: "Отменить",
  undoTitle: "Отменить последний штрих (⌘Z)",
  clearAll: "Стереть всё",
  clear: "Стереть",
  clearTitle: "Стереть весь рисунок",
  pin: "Комментарий {n}",
});

const messages = defineMessages(
  {
    notSaved: "This comment could not be saved.",
    writeReply: "Write the reply first.",
    notReady: "This page is not ready yet.",
    stopLabel: "Stop reviewing this page",
    startLabel: "Review this page: comment on text, elements, or a drawing",
  },
  {
    notSaved: "Не удалось сохранить комментарий.",
    writeReply: "Сначала напишите ответ.",
    notReady: "Страница ещё не готова.",
    stopLabel: "Закончить ревью страницы",
    startLabel: "Ревью страницы: комментарии к тексту, элементам или рисунку",
  },
);

/** How often an active tab is checked for a reload that dropped the controls. */
const CHECK_MS = 2500;
/** A drawing waits this long for its picture before it is commented on without one. */
const CAPTURE_MS = 6000;
const BODY_MAX = 8000;

const buttonClass =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

const STATE = "globalThis.__docReviewWeb";

/** Installs the controls and the bridge once per document, then switches them on. */
function installExpression(config: unknown): string {
  return (
    "(function (bb, config) {\n" +
    `if (!${STATE}) {\n${WEB_UI_SCRIPT}\n${BRIDGE_SCRIPT}\n}\n` +
    `return ${STATE}.activate(config);\n` +
    `})(bb, ${JSON.stringify(config)})`
  );
}

/** bb's colors, resolved to values the page understands. */
function themeColors(): Record<string, string> {
  const probe = document.createElement("span");
  document.body.appendChild(probe);
  const read = (variable: string) => {
    probe.style.color = `var(${variable})`;
    return getComputedStyle(probe).color;
  };
  const theme = {
    bg: read("--background"),
    fg: read("--foreground"),
    popover: read("--popover"),
    popoverFg: read("--popover-foreground"),
    muted: read("--muted"),
    mutedFg: read("--muted-foreground"),
    accent: read("--accent"),
    border: read("--border"),
    primary: read("--primary"),
    primaryFg: read("--primary-foreground"),
    destructive: read("--destructive"),
    font: getComputedStyle(document.body).fontFamily,
  };
  probe.remove();
  return theme;
}

function siteOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Timed out")), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function WebReviewAction(props: ExperimentalPluginBrowserToolbarActionProps) {
  const page = props.experimental_page;
  if (page === null || siteOf(props.url) === null) return null;
  return <WebReview {...props} page={page} />;
}

function WebReview({
  threadId,
  tabId,
  url,
  isCompactViewport,
  page,
}: ExperimentalPluginBrowserToolbarActionProps & { page: ExperimentalPluginBrowserPage }) {
  const t = useMessages(messages);
  const words = useMessages(countWords);
  const text = useMessages(pageText);
  const rpc = useReviewRpc();
  const site = siteOf(url);
  const [active, setActive] = useState(false);
  const [docId, setDocId] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  /** Counts installs: a fresh install needs the comments again. */
  const [installs, setInstalls] = useState(0);
  const [busy, setBusy] = useState(false);
  /** The token of the screenshot the server keeps for the drawing being commented on. */
  const capture = useRef<string | null>(null);
  const latest = useRef({ active, docId, url, threadId, tabId });
  latest.current = { active, docId, url, threadId, tabId };

  const tell = useCallback(
    (message: Record<string, unknown>) =>
      page
        .evaluate(`${STATE} ? ${STATE}.fromPlugin(${JSON.stringify(message)}) : null`)
        .catch(() => null),
    [page],
  );

  const install = useCallback(async () => {
    await page.evaluate(installExpression({ theme: themeColors(), text: messagesNow(pageText) }));
    setInstalls((count) => count + 1);
  }, [page]);

  const deactivate = useCallback(async () => {
    setActive(false);
    await page.evaluate(`${STATE} ? ${STATE}.deactivate() : null`).catch(() => null);
  }, [page]);

  // Without this button nobody answers the controls: switch them off with it
  // (the tab hidden behind another panel tab, or closed).
  useEffect(
    () => () => {
      void page.evaluate(`${STATE} ? ${STATE}.deactivate() : null`).catch(() => null);
    },
    [page],
  );

  // One document per site; a link to another site opens its own.
  useEffect(() => {
    if (!active || !site) return;
    let alive = true;
    rpc.call("web.open", { url: site }).then(
      (result) => alive && setDocId(result.doc.id),
      () => alive && setDocId(null),
    );
    return () => {
      alive = false;
    };
  }, [rpc, active, site]);

  const refetch = useCallback(() => {
    if (!docId) return;
    rpc.call("comments.list", { docId }).then(
      (result) => {
        if (latest.current.docId === docId) setComments(result.comments);
      },
      () => undefined,
    );
  }, [rpc, docId]);
  useEffect(refetch, [refetch]);
  useRealtime("review-changed", (payload: unknown) => {
    const ids = (payload as { docIds?: unknown } | null)?.docIds;
    if (docId && (!Array.isArray(ids) || ids.includes(docId))) refetch();
  });

  // A navigation or a reload drops what was installed: put it back.
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const check = async () => {
      const value = await page.evaluate(`${STATE} ? ${STATE}.state() : null`).catch(() => null);
      if (stopped || !latest.current.active) return;
      if ((value as { active?: unknown } | null)?.active !== true) await install().catch(() => undefined);
    };
    void check();
    const timer = window.setInterval(() => void check(), CHECK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active, url, page, install]);

  const drafts = comments.filter((comment) => comment.status === "draft").length;

  // The page shows the comments left on it; Send takes every draft on the site.
  useEffect(() => {
    if (!active) return;
    void tell({
      type: "state",
      comments: comments.filter((comment) => {
        const where = anchorPage(comment.anchor);
        return where !== null && samePage(where, url);
      }),
      drafts,
      text,
    });
  }, [active, comments, drafts, url, installs, tell, text]);

  const handle = useCallback(
    async (data: Record<string, unknown>) => {
      const req = typeof data.req === "number" ? data.req : null;
      const done = (extra: Record<string, unknown> = {}) =>
        req === null ? Promise.resolve(null) : tell({ type: "done", req, ...extra });
      const { docId, url, threadId, tabId } = latest.current;
      const id = typeof data.id === "string" ? data.id : "";
      const body = typeof data.body === "string" ? data.body.trim().slice(0, BODY_MAX) : "";
      try {
        switch (data.type) {
          case "create": {
            const anchor = readAnchor(data.anchor);
            if (!docId || !anchor || !body) throw new Error(messagesNow(messages).notSaved);
            const token = anchor.kind === "html-drawing" ? capture.current : null;
            capture.current = null;
            const comment = await rpc.call("comments.create", {
              docId,
              anchor: { ...anchor, url },
              body,
              docVersion: null,
              ...(token ? { capture: { kind: "shot" as const, token } } : {}),
            });
            refetch();
            await done({ id: comment.id });
            return;
          }
          case "reply":
            if (!body) throw new Error(messagesNow(messages).writeReply);
            await rpc.call("comments.reply", { id, body });
            break;
          case "discard-reply":
            await rpc.call("comments.discardReply", { id });
            break;
          case "delete":
            await rpc.call("comments.delete", { id });
            break;
          case "send":
            if (!docId) throw new Error(messagesNow(messages).notReady);
            await rpc.call("comments.send", { docId, target: { kind: "thread", threadId } });
            break;
          case "capture": {
            capture.current = null;
            try {
              // The picture stays on the server; the page gets its controls back as soon as it is taken.
              const shot = await withTimeout(rpc.call("web.capture", { threadId, tabId }), CAPTURE_MS);
              capture.current = shot.token;
            } catch {
              // The drawing goes without a picture; its elements still describe it.
            }
            break;
          }
          case "drop-capture":
            capture.current = null;
            break;
          case "close":
            await deactivate();
            return;
          default:
            return;
        }
        refetch();
        await done();
      } catch (cause) {
        await done({ error: errorText(cause) });
      }
    },
    [rpc, tell, refetch, deactivate],
  );

  useEffect(
    () =>
      page.onMessage((data) => {
        if (data && typeof data === "object" && !Array.isArray(data)) void handle(data as Record<string, unknown>);
      }),
    [page, handle],
  );

  const toggle = async () => {
    if (busy) return;
    if (active) {
      await deactivate();
      return;
    }
    setBusy(true);
    try {
      await install();
      setActive(true);
    } catch (cause) {
      console.warn(`Doc Review could not start on this page: ${errorText(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const label = active ? t.stopLabel : t.startLabel;
  // Drafts waiting to be sent, otherwise the agent's answers waiting for you.
  const badge = drafts || comments.filter((comment) => comment.status === "replied").length;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={busy}
      onClick={() => void toggle()}
      className={cn(buttonClass, isCompactViewport ? "w-7" : "px-2", active && "bg-state-hover text-foreground")}
    >
      <Icon name={busy ? "Loading" : "MessageSquarePlus"} className={cn("size-4", busy && "animate-spin")} />
      {isCompactViewport ? null : <span>{words.reviewButton}</span>}
      {active && badge ? (
        <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
