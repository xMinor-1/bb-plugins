// The file-opener tab: toolbar, document view, and comment list, plus the
// hand-off to the current chat or a new one.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";
import {
  useBbContext,
  useBbNavigate,
  type PluginFileOpenerProps,
  type PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { defineMessages, LanguageSwitch, messagesNow, pluralRu, useMessages } from "@/lib/i18n";
import { NeedsLibreOffice } from "@/components/viewer/NeedsLibreOffice";
import type { SheetData } from "@/lib/sheet-model";
import type {
  Capture,
  NeedsLibreOffice as NeedsLibreOfficeResult,
  ViewerLink,
  WorkbookSummary,
} from "../src/contract";
import {
  anchorLabel,
  DRAW_TOOLS,
  isDrawing,
  isPageAnchor,
  isPaged,
  type Anchor,
  type DrawTool,
  type PageInfo,
  type ReviewComment,
  type ReviewDoc,
} from "../src/types";
import { CommentEditor } from "./comment-editor";
import { CommentList, type CommentActions } from "./comment-list";
import { HtmlDoc } from "./html-doc";
import { MarkdownDoc, type MarkdownDocument, type Point } from "./markdown-doc";
import { documentRoot } from "./md-blocks";
import { PagesDoc, type PageMode } from "./pages-doc";
import { DownloadMenu, SharedBanner, useShared } from "./share-ui";
import { SheetDoc } from "./sheet-doc";
import { countWords, placeWords } from "./labels";
import { errorText, rawErrorText, useComments, useReviewDoc, useReviewRpc } from "./use-review";

/** Below this panel width the comment list becomes a bottom sheet. */
const WIDE_MIN_PX = 760;
/** Below this width the toolbar drops its labels (a phone, a thin panel). */
const COMPACT_MAX_PX = 560;
/**
 * Below this width a toolbar with selection modes shows only their icons, and
 * Send its short label, so everything fits beside the language switch.
 */
const MODE_LABELS_MIN_PX = 860;
/** How much of the view the comment sheet covers on a narrow panel. */
const SHEET_SHARE = 0.55;
/** Whether the comment list beside the document is tucked away, kept across files. */
const LIST_HIDDEN_KEY = "doc-review:list-hidden";

/** The Doc Review page's path (reviews-page.tsx), where a document opens on its own. */
const PAGE_PATH = "doc-review";

const TOOL_ICONS: Record<DrawTool, string> = { pen: "Edit", line: "Line", arrow: "ArrowUpRight", rect: "Square" };

const messages = defineMessages(
  {
    tools: (tool: DrawTool) => ({ pen: "Pen", line: "Line", arrow: "Arrow", rect: "Box" })[tool],
    toolTitles: (tool: DrawTool) =>
      ({
        pen: "Pen: cross out, underline, circle",
        line: "Line: a straight line, to underline or cross out",
        arrow: "Arrow: show where to move something",
        rect: "Box: frame a block",
      })[tool],
    sendHereLabel: "Send the drafts to this chat",
    sendNewLabel: "Start a new chat with the drafts",
    send: "Send",
    sendToChat: "Send to chat",
    sendToNewChat: "Send to new chat",
    moreSendOptions: "More send options",
    toThisChat: "To this chat",
    toThisChatHint: "The agent here gets them as the next message",
    toThisChatOff: "Open the file from a chat to use this",
    toNewChat: "To a new chat",
    toNewChatHint: "Same project and model, fresh context",
    drawingWithoutPicture: "The drawing is saved without a picture of the page.",
    couldNotSave: (reason: string) => `Could not save the comment: ${reason}`,
    openFromChat: "Open this file from a chat to send comments there.",
    sentHere: (n: number) => `Sent ${n} ${n === 1 ? "comment" : "comments"} to this chat`,
    startedNew: (n: number) => `Started a new chat with ${n} ${n === 1 ? "comment" : "comments"}`,
    open: "Open",
    converting: "Converting to PDF…",
    readingWorkbook: "Reading the workbook…",
    openingPage: "Opening the page…",
    renderingPages: "Rendering pages…",
    loading: "Loading…",
    couldNotRender: "Could not render this file.",
    tryAgain: "Try again",
    openBbPreview: "Open bb's preview",
    webBefore: (name: string) =>
      `Comments on ${name}, a live site. To see them on its pages, open it in bb's browser in the desktop app and press `,
    webAfter: " beside the address bar.",
    openSite: (name: string) => `Open ${name}`,
    selectionMode: "Selection mode",
    modeText: "Text",
    modeDraw: "Draw",
    modeElement: "Element",
    modeArea: "Area",
    modeTextTitle: "Select text to comment",
    modeDrawTitle: "Draw over the document: cross out, circle, or point with an arrow",
    modeElementTitle: "Click an element to comment on it",
    modeAreaTitle: "Draw a box to comment on an area",
    drawingTool: "Drawing tool",
    answeredPrefix: (n: number) => `${n} answered · `,
    noComments: "No comments yet",
    backToCommenting: "Back to commenting",
    classicView: "Classic view: search, zoom, print",
    comment: "Comment",
    classic: "Classic",
    showOwnPreview: "Show bb's own preview",
    hideComments: "Hide comments",
    showComments: "Show comments",
    answeredSuffix: (n: number) => `, ${n} answered`,
    commentsTitle: "Comments",
    closeComments: "Close comments",
    backToReview: "Back to review",
    couldNotOpen: (reason: string) => `Doc Review could not open this file: ${reason}`,
  },
  {
    tools: (tool) => ({ pen: "Перо", line: "Линия", arrow: "Стрелка", rect: "Рамка" })[tool],
    toolTitles: (tool) =>
      ({
        pen: "Перо: зачеркнуть, подчеркнуть, обвести",
        line: "Линия: прямая, чтобы подчеркнуть или зачеркнуть",
        arrow: "Стрелка: показать, куда что перенести",
        rect: "Рамка: обвести блок",
      })[tool],
    sendHereLabel: "Отправить черновики в этот тред",
    sendNewLabel: "Начать новый тред с черновиками",
    send: "Отправить",
    sendToChat: "Отправить в тред",
    sendToNewChat: "Отправить в новый тред",
    moreSendOptions: "Другие способы отправки",
    toThisChat: "В этот тред",
    toThisChatHint: "Агент получит их следующим сообщением",
    toThisChatOff: "Откройте файл из треда, чтобы отправить сюда",
    toNewChat: "В новый тред",
    toNewChatHint: "Тот же проект и модель, чистый контекст",
    drawingWithoutPicture: "Рисунок сохранён без снимка страницы.",
    couldNotSave: (reason) => `Не удалось сохранить комментарий: ${reason}`,
    openFromChat: "Откройте файл из треда, чтобы отправить туда комментарии.",
    sentHere: (n) => `Отправлено в этот тред: ${n} ${pluralRu(n, ["комментарий", "комментария", "комментариев"])}`,
    startedNew: (n) => `Начат новый тред с ${n} ${pluralRu(n, ["комментарием", "комментариями", "комментариями"])}`,
    open: "Открыть",
    converting: "Переводим в PDF…",
    readingWorkbook: "Читаем книгу…",
    openingPage: "Открываем страницу…",
    renderingPages: "Рисуем страницы…",
    loading: "Загружаем…",
    couldNotRender: "Не удалось показать этот файл.",
    tryAgain: "Повторить",
    openBbPreview: "Открыть просмотр bb",
    webBefore: (name) =>
      `Комментарии к сайту ${name}. Чтобы увидеть их на его страницах, откройте сайт во встроенном браузере bb в приложении для компьютера и нажмите `,
    webAfter: " рядом с адресной строкой.",
    openSite: (name) => `Открыть ${name}`,
    selectionMode: "Режим выделения",
    modeText: "Текст",
    modeDraw: "Рисовать",
    modeElement: "Элемент",
    modeArea: "Область",
    modeTextTitle: "Выделите текст, чтобы прокомментировать его",
    modeDrawTitle: "Рисуйте поверх документа: зачеркните, обведите или покажите стрелкой",
    modeElementTitle: "Нажмите на элемент, чтобы прокомментировать его",
    modeAreaTitle: "Обведите область рамкой, чтобы прокомментировать её",
    drawingTool: "Инструмент рисования",
    answeredPrefix: (n) => `с ответом: ${n} · `,
    noComments: "Комментариев пока нет",
    backToCommenting: "Вернуться к комментариям",
    classicView: "Обычный вид: поиск, масштаб, печать",
    comment: "Комментировать",
    classic: "Обычный вид",
    showOwnPreview: "Показать просмотр bb",
    hideComments: "Скрыть комментарии",
    showComments: "Показать комментарии",
    answeredSuffix: (n) => `, с ответом: ${n}`,
    commentsTitle: "Комментарии",
    closeComments: "Закрыть комментарии",
    backToReview: "Назад к ревью",
    couldNotOpen: (reason) => `Doc Review не смог открыть файл: ${reason}`,
  },
);

function readListHidden(): boolean {
  try {
    return window.localStorage.getItem(LIST_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeListHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(LIST_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Storage can be off (private mode); the choice then lasts for this tab.
  }
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function useWidth(element: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

type Content =
  | { kind: "md"; version: string; content: string; assetBaseUrl: string | null }
  | { kind: "pages"; version: string; pages: PageInfo[] }
  | { kind: "needs-libreoffice"; missing: NeedsLibreOfficeResult }
  | { kind: "sheet"; version: string; workbook: WorkbookSummary; sheet: SheetData }
  | { kind: "html"; version: string; url: string }
  | { kind: "web"; version: string };

/** Loads the document body for the current version; keeps the last one while reloading. */
function useDocContent(doc: ReviewDoc) {
  const rpc = useReviewRpc();
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    const load = async (): Promise<Content> => {
      if (doc.kind === "md") {
        return { kind: "md", ...(await rpc.call("doc.markdown", { docId: doc.id })) };
      }
      if (doc.kind === "html") {
        return { kind: "html", ...(await rpc.call("doc.html", { docId: doc.id })) };
      }
      // A live site is reviewed in bb's browser; here are only its comments.
      if (doc.kind === "web") return { kind: "web", version: doc.version };
      if (doc.kind === "spreadsheet") {
        const opened = await rpc.call("sheet.open", { docId: doc.id, locale: navigator.language || "en-US" });
        return { kind: "sheet", version: opened.version, workbook: opened.workbook, sheet: opened.sheet };
      }
      const pages = await rpc.call("doc.pages", { docId: doc.id });
      return pages.status === "ready"
        ? { kind: "pages", version: pages.version, pages: pages.pages }
        : { kind: "needs-libreoffice", missing: pages };
    };
    load().then(
      (next) => alive && setContent(next),
      (cause: unknown) => alive && setError(errorText(cause)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, doc.id, doc.kind, doc.version, reload]);

  const lastStale = useRef(0);
  const onStale = useCallback(() => {
    // Several page images fail at once when the file changes; reload once.
    const now = Date.now();
    if (now - lastStale.current < 3000) return;
    lastStale.current = now;
    setReload((value) => value + 1);
  }, []);
  const retry = useCallback(() => setReload((value) => value + 1), []);

  return { content, error, onStale, retry };
}

/** Refresh URLs well before their one-hour lease expires. */
const LINK_REFRESH_MS = 45 * 60 * 1000;

/** URLs for the classic PDF view and the original file, kept fresh while the tab is open. */
function useDocLinks(doc: ReviewDoc) {
  const rpc = useReviewRpc();
  const [links, setLinks] = useState<{ document: ViewerLink | null; download: ViewerLink } | null>(null);
  useEffect(() => {
    // A live site has no file to download.
    if (doc.kind === "web") return;
    let alive = true;
    const load = () =>
      rpc.call("doc.links", { docId: doc.id }).then(
        (next) => alive && setLinks(next),
        () => undefined,
      );
    void load();
    const timer = window.setInterval(load, LINK_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [rpc, doc.id, doc.kind, doc.version]);
  return links;
}

function SendMenu({
  count,
  canSendHere,
  busy,
  compact,
  onSend,
}: {
  count: number;
  canSendHere: boolean;
  busy: boolean;
  compact: boolean;
  onSend: (target: "thread" | "new") => void;
}) {
  const t = useMessages(messages);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const disabled = count === 0 || busy;
  const primary: "thread" | "new" = canSendHere ? "thread" : "new";
  return (
    <div ref={box} className="relative flex">
      <Button
        type="button"
        size="sm"
        className="rounded-r-none"
        disabled={disabled}
        onClick={() => onSend(primary)}
        aria-label={primary === "thread" ? t.sendHereLabel : t.sendNewLabel}
      >
        {busy ? <Icon name="Loading" className="size-3.5 animate-spin" /> : <Icon name="Sent" className="size-3.5" />}
        {compact ? t.send : primary === "thread" ? t.sendToChat : t.sendToNewChat}
        {count > 0 ? <span className="tabular-nums opacity-80">{count}</span> : null}
      </Button>
      <Button
        type="button"
        size="sm"
        className="rounded-l-none border-l border-background/25 px-1.5"
        disabled={disabled}
        aria-label={t.moreSendOptions}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="ChevronDown" className="size-3.5" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg">
          <button
            type="button"
            disabled={!canSendHere}
            className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              setOpen(false);
              onSend("thread");
            }}
          >
            <span>{t.toThisChat}</span>
            <span className="text-xs text-muted-foreground">
              {canSendHere ? t.toThisChatHint : t.toThisChatOff}
            </span>
          </button>
          <button
            type="button"
            className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onSend("new");
            }}
          >
            <span>{t.toNewChat}</span>
            <span className="text-xs text-muted-foreground">{t.toNewChatHint}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where bb resolves the Markdown's relative file links from: the workspace or
 * thread storage the file was opened in. Undefined where bb has no such root.
 */
function linkDocumentFor(
  doc: ReviewDoc,
  source: PluginFileOpenerSource,
  path: string | undefined,
  threadId: string | null,
): MarkdownDocument {
  const rootPath = path ? documentRoot(doc.absPath, path) : null;
  if (!rootPath || !threadId) return undefined;
  const relative = doc.absPath.slice(rootPath === "/" ? 1 : rootPath.length + 1);
  if (source.kind === "workspace" && source.environmentId) {
    return { threadId, rootPath, target: { kind: "workspace", environmentId: source.environmentId, path: relative } };
  }
  if (source.kind === "thread-storage" && source.threadId) {
    return {
      threadId: source.threadId,
      rootPath,
      target: { kind: "thread-storage", threadId: source.threadId, path: relative },
    };
  }
  return undefined;
}

export function Workspace({
  doc,
  source,
  path,
  onShowOriginal,
}: {
  doc: ReviewDoc;
  source: PluginFileOpenerSource;
  /** The opener's path, relative to the source's root. */
  path?: string;
  /** Absent where bb's own preview is not available. */
  onShowOriginal?: () => void;
}) {
  const t = useMessages(messages);
  const place = useMessages(placeWords);
  const count = useMessages(countWords);
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const threadId = context.threadId ?? source.threadId ?? null;
  // Keyed on values: a new object would re-render every Markdown block.
  const linkDocument = useMemo(
    () => linkDocumentFor(doc, source, path, threadId),
    [doc.absPath, source.kind, source.environmentId, source.threadId, path, threadId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const instanceId = useId();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const width = useWidth(root);
  const wide = width >= WIDE_MIN_PX;
  const compact = width > 0 && width < COMPACT_MAX_PX;
  const roomy = width === 0 || width >= MODE_LABELS_MIN_PX;
  // Phones have no built-in PDF viewer worth switching to.
  const [touchOnly] = useState(() => window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false);

  const { comments, error: commentsError, refetch, setComments } = useComments(doc.id);
  const { content, error: contentError, onStale, retry } = useDocContent(doc);
  const links = useDocLinks(doc);
  const paged = isPaged(doc.kind);
  // The classic view is the browser's own PDF viewer: search, zoom, print.
  const [classic, setClassic] = useState(false);
  const showClassic = classic && paged && !touchOnly && Boolean(links?.document);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState(0);
  const [pending, setPending] = useState<{
    anchor: Anchor;
    point: Point;
    range: Range | null;
    /** What a drawing's picture is made from. */
    capture?: Capture;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<PageMode>("text");
  const [tool, setTool] = useState<DrawTool>("pen");
  const [drawingsSaved, setDrawingsSaved] = useState(0);
  const [detached, setDetached] = useState<ReadonlySet<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);
  const [listHidden, setListHidden] = useState(readListHidden);

  const list = comments ?? [];
  const { shared, reload: reloadShared } = useShared(doc, comments);
  // What a PDF with comments would carry: comments on pages and on the whole document.
  const shareable = paged ? list.filter((comment) => comment.anchor.kind === "doc" || isPageAnchor(comment.anchor)).length : null;
  const coveredBottom = !wide && listOpen ? SHEET_SHARE : 0;
  const drafts = list.filter((comment) => comment.status === "draft");
  const needsYou = list.filter((comment) => comment.status === "replied").length;

  const onDetached = useCallback((ids: Set<string>) => {
    setDetached((current) =>
      current.size === ids.size && [...ids].every((id) => current.has(id)) ? current : ids,
    );
  }, []);

  const selectFromDoc = useCallback(
    (id: string) => {
      setActiveId(id);
      // A pin was clicked: show its comment, wherever the list lives.
      if (!wide) setListOpen(true);
      else setListHidden(false);
    },
    [wide],
  );

  // Wide: the list beside the document slides away and back, and the choice
  // is remembered. Narrow: the list is a sheet from the bottom.
  const listShown = wide ? !listHidden : listOpen;
  const toggleList = () => {
    if (!wide) {
      setListOpen((open) => !open);
      return;
    }
    const next = !listHidden;
    setListHidden(next);
    writeListHidden(next);
  };

  const selectFromList = useCallback((id: string) => {
    setActiveId(id);
    setScrollRequest((value) => value + 1);
  }, []);

  const requestComment = useCallback((anchor: Anchor, point: Point, range?: Range) => {
    setPending({ anchor, point, range: range ?? null });
    setActiveId(null);
  }, []);

  const requestPlaceComment = useCallback((anchor: Anchor, point: Point, capture?: Capture) => {
    setPending({ anchor, point, range: null, capture });
    setActiveId(null);
  }, []);

  const create = async (anchor: Anchor, body: string, capture?: Capture): Promise<ReviewComment | null> => {
    const save = (withCapture: boolean) =>
      rpc.call("comments.create", {
        docId: doc.id,
        anchor,
        body,
        docVersion: doc.version,
        ...(withCapture && capture ? { capture } : {}),
      });
    try {
      // A page too large to send still gets its drawing saved, without the picture.
      const comment = await save(true).catch((cause: unknown) => {
        if (!capture) throw cause;
        toast.warning(messagesNow(messages).drawingWithoutPicture);
        return save(false);
      });
      setComments((current) =>
        current && !current.some((item) => item.id === comment.id) ? [...current, comment] : current,
      );
      return comment;
    } catch (cause) {
      toast.error(messagesNow(messages).couldNotSave(errorText(cause)));
      return null;
    }
  };

  const actions: CommentActions = {
    onSelect: selectFromList,
    async onEdit(comment, body) {
      try {
        // An edited comment goes back to draft so it can be sent again.
        if (comment.status !== "draft") await rpc.call("comments.reopen", { id: comment.id });
        await rpc.call("comments.update", { id: comment.id, body });
        refetch();
      } catch (cause) {
        toast.error(errorText(cause));
      }
    },
    onDelete(comment) {
      setComments((current) => current?.filter((item) => item.id !== comment.id) ?? current);
      rpc.call("comments.delete", { id: comment.id }).then(refetch, (cause: unknown) => {
        toast.error(errorText(cause));
        refetch();
      });
    },
    onReopen(comment) {
      rpc.call("comments.reopen", { id: comment.id }).then(refetch, (cause: unknown) =>
        toast.error(errorText(cause)),
      );
    },
    async onReply(comment, body) {
      try {
        await rpc.call("comments.reply", { id: comment.id, body });
        refetch();
      } catch (cause) {
        toast.error(errorText(cause));
        throw cause;
      }
    },
    onDiscardReply(comment) {
      rpc.call("comments.discardReply", { id: comment.id }).then(refetch, (cause: unknown) =>
        toast.error(errorText(cause)),
      );
    },
    async onAddGeneral(body) {
      const comment = await create({ kind: "doc" }, body);
      if (comment) setActiveId(comment.id);
    },
  };

  const send = async (target: "thread" | "new") => {
    if (drafts.length === 0 || sending) return;
    setSending(true);
    const sent = drafts.length;
    try {
      if (target === "thread") {
        if (!threadId) throw new Error(messagesNow(messages).openFromChat);
        await rpc.call("comments.send", { docId: doc.id, target: { kind: "thread", threadId } });
        toast.success(messagesNow(messages).sentHere(sent));
      } else {
        try {
          const result = await rpc.call("comments.send", {
            docId: doc.id,
            target: {
              kind: "new-thread",
              sourceThreadId: threadId,
              projectId: source.projectId,
              environmentId: source.kind === "workspace" ? source.environmentId : null,
            },
          });
          const now = messagesNow(messages);
          toast.success(now.startedNew(sent), {
            action: { label: now.open, onClick: () => navigate.toThread(result.threadId) },
          });
        } catch (cause) {
          if (!/not in a project/i.test(rawErrorText(cause))) throw cause;
          // No project to start a chat in: prefill the new-chat screen instead.
          const handoff = await rpc.call("comments.handoffPrompt", { docId: doc.id });
          await rpc.call("comments.markSent", { ids: handoff.ids, threadId: null });
          navigate.toCompose({ initialPrompt: handoff.prompt, focusPrompt: true });
        }
      }
      refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSending(false);
    }
  };

  const composer = pending ? (
    <CommentEditor
      label={anchorLabel(pending.anchor, doc.kind, place)}
      busy={saving}
      onCancel={() => setPending(null)}
      onSubmit={(body) => {
        setSaving(true);
        create(pending.anchor, body, pending.capture)
          .then((comment) => {
            if (!comment) return;
            setPending(null);
            setActiveId(comment.id);
            if (isDrawing(comment.anchor)) setDrawingsSaved((count) => count + 1);
          })
          .finally(() => setSaving(false));
      }}
    />
  ) : null;

  const listPanel = (
    <CommentList
      comments={list}
      kind={doc.kind}
      docVersion={doc.version}
      activeId={activeId}
      detachedIds={detached}
      actions={actions}
      header={
        commentsError ? <p className="text-xs text-destructive">{commentsError}</p> : null
      }
    />
  );

  const loadingLabel =
    doc.kind === "text" || doc.kind === "presentation"
      ? t.converting
      : doc.kind === "spreadsheet"
        ? t.readingWorkbook
        : doc.kind === "html"
          ? t.openingPage
        : doc.kind === "pdf"
          ? t.renderingPages
          : t.loading;

  const body = contentError ? (
    <Centered>
      <p className="text-foreground">{t.couldNotRender}</p>
      <p className="max-w-md text-xs">{contentError}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          {t.tryAgain}
        </Button>
        {onShowOriginal ? (
          <Button type="button" variant="ghost" size="sm" onClick={onShowOriginal}>
            {t.openBbPreview}
          </Button>
        ) : null}
      </div>
    </Centered>
  ) : !content ? (
    <Centered>
      <Icon name="Loading" className="size-5 animate-spin" />
      <p>{loadingLabel}</p>
    </Centered>
  ) : showClassic && links?.document ? (
    <iframe
      key={`${doc.id}:${doc.version}`}
      src={links.document.url}
      title={doc.name}
      className="absolute inset-0 h-full w-full border-0 bg-muted"
    />
  ) : content.kind === "needs-libreoffice" ? (
    <NeedsLibreOffice
      result={content.missing}
      name={doc.name}
      downloadUrl={links?.download.url ?? null}
      onReload={retry}
    />
  ) : content.kind === "sheet" ? (
    <SheetDoc
      key={`${doc.id}:${content.version}`}
      docId={doc.id}
      initial={content}
      comments={list}
      activeId={activeId}
      scrollRequest={scrollRequest}
      pendingAnchor={pending?.anchor ?? null}
      composer={composer}
      composerPoint={pending?.point ?? null}
      onRequestComment={requestComment}
      onSelectComment={selectFromDoc}
    />
  ) : content.kind === "web" ? (
    <Centered>
      <Icon name="Globe" className="size-6" />
      <p className="max-w-sm">
        {t.webBefore(doc.name)}
        <span className="font-medium text-foreground">{count.reviewButton}</span>
        {t.webAfter}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => navigate.openUrl(doc.absPath)}>
        {t.openSite(doc.name)}
      </Button>
    </Centered>
  ) : content.kind === "html" ? (
    <HtmlDoc
      url={content.url}
      name={doc.name}
      mode={mode}
      tool={tool}
      drawingsSaved={drawingsSaved}
      comments={list}
      activeId={activeId}
      scrollRequest={scrollRequest}
      pendingAnchor={pending?.anchor ?? null}
      composer={composer}
      composerPoint={pending?.point ?? null}
      onRequestComment={requestPlaceComment}
      onSelectComment={selectFromDoc}
      onDetached={onDetached}
    />
  ) : content.kind === "md" ? (
    <MarkdownDoc
      instanceId={instanceId}
      content={content.content}
      assetBaseUrl={content.assetBaseUrl}
      linkDocument={linkDocument}
      comments={list}
      activeId={activeId}
      scrollRequest={scrollRequest}
      scroller={scroller}
      coveredBottom={coveredBottom}
      pendingRange={pending?.range ?? null}
      composer={composer}
      composerPoint={pending?.point ?? null}
      onRequestComment={requestComment}
      onSelectComment={selectFromDoc}
      onDetached={onDetached}
    />
  ) : (
    <PagesDoc
      docId={doc.id}
      kind={doc.kind}
      version={content.version}
      pages={content.pages}
      mode={mode}
      tool={tool}
      drawingsSaved={drawingsSaved}
      comments={list}
      activeId={activeId}
      scrollRequest={scrollRequest}
      scroller={scroller}
      overlay={overlay}
      coveredBottom={coveredBottom}
      pendingAnchor={pending?.anchor ?? null}
      composer={composer}
      composerPoint={pending?.point ?? null}
      onStale={onStale}
      onRequestComment={requestPlaceComment}
      onSelectComment={selectFromDoc}
    />
  );

  const hasPages = paged && content?.kind === "pages" && !showClassic;
  const isHtml = content?.kind === "html";
  // Pages switch between text, areas, and drawing; HTML between text, elements, and drawing.
  const hasModes = hasPages || isHtml;
  const ownScroll = content?.kind === "sheet" || isHtml || showClassic;
  return (
    <div ref={root} className="relative flex h-full min-h-0 flex-col bg-background">
      <div className={cn("flex shrink-0 items-center border-b border-border py-2", compact ? "gap-1 px-2" : "gap-2 px-3")}>
        {hasModes ? (
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label={t.selectionMode}>
            {(["text", "area", "draw"] as const).map((value) => {
              const label = value === "text" ? t.modeText : value === "draw" ? t.modeDraw : isHtml ? t.modeElement : t.modeArea;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  title={
                    value === "text"
                      ? t.modeTextTitle
                      : value === "draw"
                        ? t.modeDrawTitle
                        : isHtml
                          ? t.modeElementTitle
                          : t.modeAreaTitle
                  }
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs",
                    mode === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon
                    name={value === "text" ? "TextWrap" : value === "draw" ? "Edit" : isHtml ? "Target" : "Square"}
                    className="size-3.5"
                  />
                  {roomy ? label : <span className="sr-only">{label}</span>}
                </button>
              );
            })}
          </div>
        ) : null}
        {hasModes && mode === "draw" ? (
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label={t.drawingTool}>
            {DRAW_TOOLS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={tool === value}
                aria-label={t.tools(value)}
                title={t.toolTitles(value)}
                onClick={() => setTool(value)}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-[5px]",
                  tool === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon name={TOOL_ICONS[value]} className="size-3.5" />
              </button>
            ))}
          </div>
        ) : null}
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {compact ? null : (
            <>
              {needsYou > 0 ? t.answeredPrefix(needsYou) : ""}
              {list.length === 0 ? t.noComments : count.comments(list.length)}
            </>
          )}
        </div>
        {paged && !touchOnly && links?.document ? (
          <span className="inline-flex" title={showClassic ? t.backToCommenting : t.classicView}>
            <Button
              type="button"
              variant={showClassic ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2 text-xs"
              aria-pressed={showClassic}
              aria-label={showClassic ? t.backToCommenting : t.classicView}
              onClick={() => setClassic((value) => !value)}
            >
              <Icon name={showClassic ? "MessageSquare" : "Eye"} className="size-4" />
              {compact || (hasModes && !roomy) ? null : showClassic ? t.comment : t.classic}
            </Button>
          </span>
        ) : null}
        {(doc.kind === "md" || doc.kind === "html") && onShowOriginal ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label={t.showOwnPreview}
            onClick={onShowOriginal}
          >
            <Icon name="Eye" className="size-4" />
          </Button>
        ) : null}
        {links ? <DownloadMenu doc={doc} original={links.download} shareable={shareable} /> : null}
        <span className="inline-flex" title={listShown ? t.hideComments : t.showComments}>
          <Button
            type="button"
            variant={listShown ? "secondary" : "ghost"}
            size="sm"
            className="relative h-8 px-2"
            aria-pressed={listShown}
            aria-label={
              (listShown ? t.hideComments : t.showComments) + (needsYou > 0 ? t.answeredSuffix(needsYou) : "")
            }
            onClick={toggleList}
          >
            <Icon name="MessageSquare" className="size-4" />
            <span className="tabular-nums">{list.length}</span>
            {needsYou > 0 ? (
              <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" aria-hidden />
            ) : null}
          </Button>
        </span>
        {compact ? null : <LanguageSwitch />}
        <SendMenu
          count={drafts.length}
          canSendHere={Boolean(threadId)}
          busy={sending}
          compact={compact || (hasModes && !roomy)}
          onSend={(target) => void send(target)}
        />
      </div>
      {shared ? (
        <SharedBanner
          doc={doc}
          shared={shared}
          onImported={() => {
            refetch();
            reloadShared();
          }}
          onOpen={(docId) => navigate.toPluginPanel(PAGE_PATH, { subPath: `doc/${docId}` })}
        />
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <div
            ref={scroller}
            className={cn(
              "relative min-w-0 flex-1",
              ownScroll ? "overflow-hidden" : "overflow-auto",
              // Pages zoom by pinching inside the view, not the whole app.
              hasPages && "overscroll-x-contain [scrollbar-gutter:stable] [touch-action:pan-x_pan-y]",
            )}
          >
            {body}
          </div>
          <div ref={setOverlay} className="pointer-events-none absolute inset-0 z-30" />
        </div>
        {wide ? (
          <aside
            aria-hidden={listHidden}
            inert={listHidden}
            className={cn(
              "shrink-0 overflow-hidden border-border bg-background transition-[width] duration-200 ease-out",
              listHidden ? "w-0" : "w-80 border-l",
            )}
          >
            {/* Fixed width inside, so the list slides instead of reflowing. */}
            <div className="h-full w-80 overflow-y-auto">{listPanel}</div>
          </aside>
        ) : null}
      </div>
      {!wide && listOpen ? (
        <div className="absolute inset-x-0 bottom-0 z-40 max-h-[55%] overflow-y-auto overscroll-contain rounded-t-xl border-t border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-3 py-1.5">
            <span className="text-xs font-medium">{t.commentsTitle}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t.closeComments}
              onClick={() => setListOpen(false)}
            >
              <Icon name="ChevronDown" className="size-4" />
            </Button>
          </div>
          {listPanel}
        </div>
      ) : null}
    </div>
  );
}

export function ReviewOpener({ path, source, Original }: PluginFileOpenerProps) {
  const t = useMessages(messages);
  const { doc, error } = useReviewDoc(path, source);
  const [original, setOriginal] = useState(false);
  const back = useMemo(
    () => (
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOriginal(false)}>
          <Icon name="MessageSquare" className="size-4" />
          {t.backToReview}
        </Button>
      </div>
    ),
    [t],
  );

  if (original || (error && !doc)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {error ? (
          <div className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            {t.couldNotOpen(error)}
          </div>
        ) : (
          back
        )}
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      </div>
    );
  }
  if (!doc) {
    return (
      <Centered>
        <Icon name="Loading" className="size-5 animate-spin" />
      </Centered>
    );
  }
  return <Workspace doc={doc} source={source} path={path} onShowOriginal={() => setOriginal(true)} />;
}
