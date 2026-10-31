// A folder: the message list with search, the open message, and a reply box.
import { useCallback, useEffect, useState } from "react";
import type { Folder, MailAddress, MailMessage, MessageSummary } from "../../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { intlLocale, useLang, useMessages, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { messages as texts } from "../messages";
import { Attachments } from "./Attachments";
import { Conversation } from "./Conversation";
import { DraftCard, formatAddress, textareaClass } from "./DraftCard";
import { MessageBody } from "./MessageBody";
import { People, Person, shownName } from "./People";
import { RecipientsInput } from "./RecipientsInput";
import { splitRecipients } from "../shared/recipients";
import { Notice, errorText } from "./ui";
import { useExplain } from "./errors";
import type { Rpc } from "./rpc";

const PAGE = 30;

function shortTime(iso: string | null, lang: Lang): string {
  if (!iso) return "";
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(intlLocale(lang), { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(intlLocale(lang), { day: "numeric", month: "short", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function Mailbox({ rpc, hostId, folder }: { rpc: Rpc; hostId: string; folder: Folder }) {
  const t = useMessages(texts);
  const explain = useExplain();
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(
    (offset: number) => {
      setLoading(true);
      setError(null);
      rpc
        .call("list", { hostId, folder, offset, limit: PAGE, ...(applied ? { query: applied } : {}) })
        .then(
          (page) => {
            setMessages((current) => (offset === 0 ? page.messages : [...(current ?? []), ...page.messages]));
            setMore(page.more);
          },
          (cause) => setError(errorText(cause)),
        )
        .finally(() => setLoading(false));
    },
    [rpc, hostId, folder, applied],
  );

  useEffect(() => {
    setSelected(null);
    load(0);
  }, [load]);

  const markRead = (ref: string) => setMessages((current) => current?.map((m) => (m.ref === ref ? { ...m, isRead: true } : m)) ?? null);

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(18rem,26rem)_1fr]">
      {/* Below the lg breakpoint the open message takes the list's place. */}
      <div className={cn("min-w-0 space-y-2", selected && "hidden lg:block")}>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(query.trim());
          }}
        >
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.searchPlaceholder} title={t.searchHint} />
          <Button type="submit" variant="outline">
            {t.search}
          </Button>
          <Button type="button" variant="ghost" onClick={() => (applied ? setApplied("") : load(0))} disabled={loading}>
            {applied ? t.clear : t.refresh}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t.searchHint}</p>
        {error ? <Notice tone="error">{explain(error)}</Notice> : null}
        {messages === null && !error ? <Notice tone="info">{t.loading}</Notice> : null}
        {messages?.length === 0 ? <Notice tone="info">{applied ? t.nothingFound : t.noMessages}</Notice> : null}
        {messages?.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {messages.map((message) => (
              <li key={message.ref}>
                <button
                  type="button"
                  onClick={() => setSelected(message.ref)}
                  className={cn("block w-full px-3 py-2 text-left text-sm hover:bg-state-hover", selected === message.ref && "bg-state-active")}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate", !message.isRead && "font-semibold")}>
                      {!message.isRead ? <span className="mr-1.5 inline-block size-2 rounded-full bg-foreground align-middle" aria-label={t.unread} /> : null}
                      {folder === "sent" || folder === "drafts" ? message.displayTo || t.noRecipients : message.from ? shownName(message.from) : t.unknownSender}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{shortTime(message.received, lang)}</span>
                  </span>
                  <span className={cn("block truncate", !message.isRead && "font-medium")}>{message.subject || t.noSubject}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {message.hasAttachments ? t.attachmentMark : ""}
                    {message.preview}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {more ? (
          <Button variant="outline" className="w-full" onClick={() => load(messages?.length ?? 0)} disabled={loading}>
            {loading ? t.loading : t.loadMore}
          </Button>
        ) : null}
      </div>

      <div className={cn("min-w-0", !selected && "hidden lg:block")}>
        {selected ? (
          <Button variant="ghost" size="sm" className="mb-2 lg:hidden" onClick={() => setSelected(null)}>
            {t.back}
          </Button>
        ) : null}
        {selected ? (
          <MessageView key={selected} rpc={rpc} hostId={hostId} ref_={selected} onRead={markRead} onOpen={setSelected} canReply={folder !== "drafts"} />
        ) : (
          <Notice tone="info">{t.chooseMessage}</Notice>
        )}
      </div>
    </div>
  );
}

type ComposeMode = { kind: "reply" | "replyAll" | "forward" } | { kind: "new"; to: MailAddress };

const cidKey = (value: string) => value.replace(/^cid:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();

function MessageView({
  rpc,
  hostId,
  ref_,
  onRead,
  onOpen,
  canReply,
}: {
  rpc: Rpc;
  hostId: string;
  ref_: string;
  onRead: (ref: string) => void;
  onOpen: (ref: string) => void;
  canReply: boolean;
}) {
  const t = useMessages(texts);
  const explain = useExplain();
  const lang = useLang();
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [images, setImages] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    rpc.call("read", { hostId, ref: ref_ }).then(
      (result) => {
        setMessage(result);
        onRead(ref_);
      },
      (cause) => setError(errorText(cause)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, hostId, ref_]);

  // Pictures the message carries itself, for its HTML: fetched only when the HTML names one.
  useEffect(() => {
    if (!message?.html || !/\bcid:/i.test(message.html)) return;
    let live = true;
    rpc.call("inlineImages", { hostId, ref: ref_ }).then(
      (result) => live && setImages(new Map(result.images.map((image) => [cidKey(image.contentId), image.dataUrl]))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, hostId, ref_, message?.html]);

  if (error) return <Notice tone="error">{explain(error)}</Notice>;
  if (!message) return <Notice tone="info">{t.opening}</Notice>;

  const write = (person: MailAddress) => {
    setDraftId(null);
    setCompose({ kind: "new", to: person });
  };
  const html = message.bodyFormat === "text" ? null : message.html;
  // Pictures shown inside an HTML text are not listed again as files.
  const files = message.attachments.filter((a) => !(a.inline && html));

  return (
    <article className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-base font-semibold break-words">{message.subject || t.noSubject}</h2>
        <p className="text-sm break-words">
          <span className="text-muted-foreground">{t.from} </span>
          {message.from ? <Person person={message.from} onWrite={write} /> : t.unknownSender}
        </p>
        <p className="text-sm break-words">
          <span className="text-muted-foreground">{t.to} </span>
          {message.to.length ? <People people={message.to} onWrite={write} /> : t.nobodyListed}
        </p>
        {message.cc.length ? (
          <p className="text-sm break-words">
            <span className="text-muted-foreground">{t.cc} </span>
            <People people={message.cc} onWrite={write} />
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{message.received ? new Date(message.received).toLocaleString(intlLocale(lang)) : ""}</p>
      </header>

      <Conversation rpc={rpc} hostId={hostId} messageRef={ref_} onOpen={onOpen} />

      {canReply ? (
        <div className="flex flex-wrap gap-2">
          {(["reply", "replyAll", "forward"] as const).map((kind) => (
            <Button
              key={kind}
              variant={compose?.kind === kind ? "secondary" : "outline"}
              size="sm"
              onClick={() => {
                setDraftId(null);
                setCompose({ kind });
              }}
            >
              {kind === "reply" ? t.reply : kind === "replyAll" ? t.replyAll : t.forward}
            </Button>
          ))}
        </div>
      ) : null}

      {compose ? (
        <Composer
          key={compose.kind === "new" ? `new:${compose.to.email}` : compose.kind}
          rpc={rpc}
          hostId={hostId}
          mode={compose}
          replyTo={ref_}
          onSaved={(id) => {
            setDraftId(id);
            setCompose(null);
          }}
          onCancel={() => setCompose(null)}
        />
      ) : null}

      {draftId ? <DraftCard rpc={rpc} target={{ hostId }} id={draftId} /> : null}

      <MessageBody text={message.body} html={html} images={images} />
      <Attachments rpc={rpc} hostId={hostId} messageRef={ref_} attachments={files} />
    </article>
  );
}

const recipientsOf = splitRecipients;

function Composer({
  rpc,
  hostId,
  mode,
  replyTo,
  onSaved,
  onCancel,
}: {
  rpc: Rpc;
  hostId: string;
  mode: ComposeMode;
  replyTo: string;
  onSaved: (draftId: string) => void;
  onCancel: () => void;
}) {
  const t = useMessages(texts);
  const explain = useExplain();
  const [to, setTo] = useState(mode.kind === "new" ? formatAddress(mode.to) : "");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsTo = mode.kind === "forward" || mode.kind === "new";
  const ready = (!needsTo || recipientsOf(to).length > 0) && (mode.kind === "forward" || text.trim() !== "") && (mode.kind !== "new" || subject.trim() !== "");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const draft = await rpc.call("saveDraft", {
        hostId,
        kind: mode.kind,
        ...(mode.kind === "new" ? { subject } : { replyTo }),
        ...(needsTo ? { to: recipientsOf(to) } : {}),
        body: text,
      });
      onSaved(draft.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {needsTo ? <RecipientsInput rpc={rpc} hostId={hostId} value={to} onChange={setTo} placeholder={t.toPlaceholder} ariaLabel={t.to} /> : null}
      {mode.kind === "new" ? <Input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder={t.subjectPlaceholder} aria-label={t.subjectPlaceholder} /> : null}
      <textarea
        className={textareaClass}
        rows={8}
        autoFocus={!needsTo}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={mode.kind === "forward" ? t.forwardPlaceholder : mode.kind === "new" ? t.newPlaceholder : t.replyPlaceholder}
      />
      {error ? <Notice tone="error">{explain(error)}</Notice> : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving || !ready}>
          {saving ? t.saving : t.prepare}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}
