// The comment list: drafts to send, comments waiting on an agent, answers
// that need the user, and resolved ones. Each comment keeps its thread with
// the agent, and the user answers in it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { defineMessages, useLang, useMessages } from "@/lib/i18n";
import {
  anchorLabel,
  anchorQuote,
  draftReply,
  replyAuthor,
  sharedWithOthers,
  truncate,
  type CommentReply,
  type CommentStatus,
  type DocKind,
  type ReviewComment,
} from "../src/types";
import { CommentEditor } from "./comment-editor";
import { authorWords, placeWords, STATUS_LABELS } from "./labels";

const SECTIONS: CommentStatus[] = ["replied", "draft", "sent", "resolved"];

const messages = defineMessages(
  {
    sectionTitles: (status: CommentStatus) =>
      ({ replied: "Needs you", draft: "Drafts", sent: "Waiting for the agent", resolved: "Done" })[status],
    sectionHints: (status: CommentStatus) =>
      ({
        replied: "The agent answered instead of changing the file.",
        draft: "Not sent yet: comments and your replies go out together.",
        sent: "",
        resolved: "",
      })[status],
    commentPlaceholder: "What should change here?",
    replyPlaceholder: "Answer the agent",
    answerName: (name: string) => `Answer ${name}`,
    discardReply: "Discard reply",
    writtenOn: (file: string) => `Written on ${file}`,
    editReply: "Edit reply",
    editComment: "Edit comment",
    backToDraft: "Back to draft",
    deleteComment: "Delete comment",
    drawingAlt: "The drawing on the page",
    save: "Save",
    reply: "Reply",
    elementGone: "The element is no longer on the page.",
    quoteGone: "The quoted text is no longer in the file.",
    fileChanged: "The file changed after this comment.",
    wholeDocument: "Whole document",
    commentWhole: "Comment on the whole document",
    emptyWeb:
      "Open the site in bb's browser in the desktop app and press Review beside the address bar to comment on its pages.",
    emptySheet: "Click a cell or drag over a range to comment on it.",
    emptyHtml:
      "Select text to comment on it. Switch to Element to click a block, button, or picture, or to Draw to mark up the page.",
    emptyMd: "Select text to comment on it.",
    emptyPages:
      "Select text to comment on it. Switch to Area to draw a box around a picture or chart, or to Draw to mark up the page.",
    draftsNote: "Comments stay here as drafts until you send them to a chat.",
  },
  {
    sectionTitles: (status) =>
      ({ replied: "Ждут вас", draft: "Черновики", sent: "Ждут агента", resolved: "Готово" })[status],
    sectionHints: (status) =>
      ({
        replied: "Агент ответил, а не поменял файл.",
        draft: "Ещё не отправлены: комментарии и ваши ответы уйдут вместе.",
        sent: "",
        resolved: "",
      })[status],
    commentPlaceholder: "Что здесь поменять?",
    replyPlaceholder: "Ответьте агенту",
    answerName: (name) => `Ответ для ${name}`,
    discardReply: "Удалить ответ",
    writtenOn: (file) => `Написан к файлу ${file}`,
    editReply: "Изменить ответ",
    editComment: "Изменить комментарий",
    backToDraft: "Вернуть в черновики",
    deleteComment: "Удалить комментарий",
    drawingAlt: "Рисунок на странице",
    save: "Сохранить",
    reply: "Ответить",
    elementGone: "Этого элемента больше нет на странице.",
    quoteGone: "Процитированного текста больше нет в файле.",
    fileChanged: "Файл изменился после этого комментария.",
    wholeDocument: "Весь документ",
    commentWhole: "Комментарий ко всему документу",
    emptyWeb:
      "Откройте сайт во встроенном браузере bb в приложении для компьютера и нажмите «Ревью» рядом с адресной строкой, чтобы комментировать его страницы.",
    emptySheet: "Нажмите на ячейку или протяните по диапазону, чтобы прокомментировать.",
    emptyHtml:
      "Выделите текст, чтобы прокомментировать его. В режиме «Элемент» можно нажать на блок, кнопку или картинку, в режиме «Рисовать» — размечать страницу.",
    emptyMd: "Выделите текст, чтобы прокомментировать его.",
    emptyPages:
      "Выделите текст, чтобы прокомментировать его. В режиме «Область» можно обвести картинку или график рамкой, в режиме «Рисовать» — размечать страницу.",
    draftsNote: "Комментарии лежат здесь черновиками, пока вы не отправите их в тред.",
  },
);

export interface CommentActions {
  onSelect: (id: string) => void;
  onEdit: (comment: ReviewComment, body: string) => Promise<void>;
  onDelete: (comment: ReviewComment) => void;
  onReopen: (comment: ReviewComment) => void;
  /** Writes the user's answer in the thread, or replaces the unsent one. */
  onReply: (comment: ReviewComment, body: string) => Promise<void>;
  onDiscardReply: (comment: ReviewComment) => void;
  onAddGeneral: (body: string) => Promise<void>;
}

function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground hover:text-foreground"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} className="size-3.5" />
    </Button>
  );
}

function ReplyBubble({
  reply,
  highlight,
  onDiscard,
}: {
  reply: CommentReply;
  /** The agent's answer the user still has to respond to. */
  highlight: boolean;
  onDiscard?: () => void;
}) {
  const t = useMessages(messages);
  const authors = useMessages(authorWords);
  const draft = reply.author === "user" && reply.sentAt === null;
  return (
    <div
      className={cn(
        "mt-2 rounded-md px-2 py-1.5 text-xs",
        reply.author === "agent"
          ? highlight
            ? "bg-primary/10 text-foreground"
            : "bg-muted text-muted-foreground"
          : cn("ml-4 border text-foreground", draft ? "border-dashed border-primary/50" : "border-border"),
      )}
    >
      <div className="flex items-start gap-1">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          <span className="font-medium">{replyAuthor(reply, authors)}:</span>{" "}
          {reply.body}
        </p>
        {onDiscard ? (
          <IconButton icon="X" label={t.discardReply} onClick={onDiscard} />
        ) : null}
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  kind,
  active,
  stale,
  detached,
  actions,
}: {
  comment: ReviewComment;
  kind: DocKind;
  active: boolean;
  stale: boolean;
  detached: boolean;
  actions: CommentActions;
}) {
  const t = useMessages(messages);
  const place = useMessages(placeWords);
  const statuses = STATUS_LABELS[useLang()];
  const heading = `${anchorLabel(comment.anchor, kind, place)} · ${statuses[comment.status]}`;
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const quote = anchorQuote(comment.anchor);
  const pending = draftReply(comment);
  const sentThread = pending ? comment.thread.slice(0, -1) : comment.thread;
  // The pencil edits the unsent reply, or the comment while nobody answered it.
  // Another reviewer's comment is this user's copy to adjust before passing it on.
  const others = sharedWithOthers(comment);
  const editable = pending !== null || ((comment.thread.length === 0 || others) && comment.status !== "resolved");
  const canReply = comment.status === "replied" || comment.status === "resolved" || (others && pending === null);
  const lastName = comment.thread.filter((reply) => reply.name !== null).at(-1)?.name ?? comment.author;
  const replyPlaceholder = others && comment.status === "draft" && lastName ? t.answerName(lastName) : t.replyPlaceholder;
  const editor = (options: {
    initial: string;
    submitLabel: string;
    placeholder: string;
    save: (body: string) => Promise<void>;
    close: () => void;
  }) => (
    <CommentEditor
      className="mt-2 shadow-none"
      initial={options.initial}
      submitLabel={options.submitLabel}
      placeholder={options.placeholder}
      busy={busy}
      onCancel={options.close}
      onSubmit={(body) => {
        setBusy(true);
        // A failed save keeps the editor open with the text; the toast says why.
        options
          .save(body)
          .then(options.close, () => undefined)
          .finally(() => setBusy(false));
      }}
    />
  );

  useEffect(() => {
    if (active) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <div
      ref={card}
      role="button"
      tabIndex={0}
      onClick={() => actions.onSelect(comment.id)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          actions.onSelect(comment.id);
        }
      }}
      className={cn(
        "group rounded-lg border bg-card p-2.5 text-sm outline-none transition-colors",
        active ? "border-primary/60 ring-1 ring-primary/30" : "border-border hover:border-foreground/20",
        comment.status === "resolved" && !active && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold",
            comment.status === "resolved"
              ? "bg-muted text-muted-foreground"
              : "bg-primary text-primary-foreground",
          )}
        >
          {comment.seq}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={heading}>
          {heading}
          {comment.author ? (
            <span
              className="ml-1.5 font-medium text-foreground"
              title={comment.originFile ? t.writtenOn(comment.originFile) : undefined}
            >
              {comment.author}
            </span>
          ) : null}
        </span>
        <div className="flex shrink-0 items-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          {editable ? (
            <IconButton
              icon="Edit"
              label={pending ? t.editReply : t.editComment}
              onClick={() => setEditing(true)}
            />
          ) : null}
          {comment.status !== "draft" ? (
            <IconButton
              icon="RotateCcw"
              label={t.backToDraft}
              onClick={() => actions.onReopen(comment)}
            />
          ) : null}
          <IconButton icon="Trash2" label={t.deleteComment} onClick={() => actions.onDelete(comment)} />
        </div>
      </div>
      {comment.imageUrl ? (
        // The picture the agent gets with a drawing.
        <img
          src={comment.imageUrl}
          alt={t.drawingAlt}
          loading="lazy"
          className="mt-1.5 max-h-40 w-full rounded border border-border bg-muted object-contain"
        />
      ) : quote ? (
        <div className="mt-1.5 line-clamp-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
          {truncate(quote, 240)}
        </div>
      ) : null}
      {editing && !pending ? (
        editor({
          initial: comment.body,
          submitLabel: t.save,
          placeholder: t.commentPlaceholder,
          save: (body) => actions.onEdit(comment, body),
          close: () => setEditing(false),
        })
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap break-words">{comment.body}</p>
      )}
      {sentThread.map((reply, index) => (
        <ReplyBubble
          key={reply.id}
          reply={reply}
          highlight={comment.status === "replied" && index === sentThread.length - 1}
        />
      ))}
      {pending ? (
        editing ? (
          editor({
            initial: pending.body,
            submitLabel: t.save,
            placeholder: replyPlaceholder,
            save: (body) => actions.onReply(comment, body),
            close: () => setEditing(false),
          })
        ) : (
          <ReplyBubble
            reply={pending}
            highlight={false}
            onDiscard={() => actions.onDiscardReply(comment)}
          />
        )
      ) : null}
      {canReply ? (
        replying ? (
          editor({
            initial: "",
            submitLabel: t.reply,
            placeholder: replyPlaceholder,
            save: (body) => actions.onReply(comment, body),
            close: () => setReplying(false),
          })
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              setReplying(true);
            }}
          >
            <Icon name="Reply" className="size-3.5" />
            {t.reply}
          </Button>
        )
      ) : null}
      {(stale || detached) && comment.status !== "resolved" ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          {detached
            ? comment.anchor.kind === "html-element"
              ? t.elementGone
              : t.quoteGone
            : t.fileChanged}
        </div>
      ) : null}
    </div>
  );
}

export function CommentList({
  comments,
  kind,
  docVersion,
  activeId,
  detachedIds,
  actions,
  header,
}: {
  comments: ReviewComment[];
  kind: DocKind;
  docVersion: string;
  activeId: string | null;
  detachedIds: ReadonlySet<string>;
  actions: CommentActions;
  header?: ReactNode;
}) {
  const t = useMessages(messages);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);

  return (
    <div className="flex flex-col gap-3 p-3">
      {header}
      {composing ? (
        <CommentEditor
          label={t.wholeDocument}
          busy={busy}
          onCancel={() => setComposing(false)}
          onSubmit={(body) => {
            setBusy(true);
            actions
              .onAddGeneral(body)
              .then(() => setComposing(false))
              .finally(() => setBusy(false));
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={() => setComposing(true)}
        >
          <Icon name="MessageSquarePlus" className="size-4" />
          {t.commentWhole}
        </Button>
      )}
      {comments.length === 0 ? (
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          {kind === "web"
            ? t.emptyWeb
            : kind === "spreadsheet"
            ? t.emptySheet
            : kind === "html"
              ? t.emptyHtml
              : kind === "md"
                ? t.emptyMd
                : t.emptyPages}
          {" "}{t.draftsNote}
        </p>
      ) : null}
      {SECTIONS.map((status) => {
        const items = comments.filter((comment) => comment.status === status);
        if (items.length === 0) return null;
        const collapsed = status === "resolved" && !showDone;
        const hint = t.sectionHints(status);
        return (
          <section key={status} className="flex flex-col gap-2">
            <button
              type="button"
              className="flex items-center gap-1.5 px-1 text-left text-xs font-medium text-muted-foreground"
              onClick={() => status === "resolved" && setShowDone((value) => !value)}
            >
              {status === "resolved" ? (
                <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
              ) : null}
              {t.sectionTitles(status)} · {items.length}
            </button>
            {hint && !collapsed ? (
              <p className="-mt-1 px-1 text-[11px] text-muted-foreground">{hint}</p>
            ) : null}
            {collapsed
              ? null
              : items.map((comment) => (
                  <CommentCard
                    key={comment.id}
                    comment={comment}
                    kind={kind}
                    active={comment.id === activeId}
                    stale={comment.docVersion !== null && comment.docVersion !== docVersion}
                    detached={detachedIds.has(comment.id)}
                    actions={actions}
                  />
                ))}
          </section>
        );
      })}
    </div>
  );
}
