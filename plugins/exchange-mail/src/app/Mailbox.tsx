// A folder: the message list with search, the open message, and a reply box.
import { useCallback, useEffect, useState } from "react";
import type { Folder, MailMessage, MessageSummary } from "../../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { intlLocale, useLang, useMessages, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { messages as texts } from "../messages";
import { DraftCard, formatAddress, textareaClass } from "./DraftCard";
import { Notice, errorText } from "./ui";
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
        {error ? <Notice tone="error">{error}</Notice> : null}
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
                      {folder === "sent" || folder === "drafts" ? message.displayTo || t.noRecipients : message.from ? message.from.name || message.from.email : t.unknownSender}
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
          <MessageView key={selected} rpc={rpc} hostId={hostId} ref_={selected} onRead={markRead} canReply={folder !== "drafts"} />
        ) : (
          <Notice tone="info">{t.chooseMessage}</Notice>
        )}
      </div>
    </div>
  );
}

function MessageView({ rpc, hostId, ref_, onRead, canReply }: { rpc: Rpc; hostId: string; ref_: string; onRead: (ref: string) => void; canReply: boolean }) {
  const t = useMessages(texts);
  const lang = useLang();
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<null | "reply" | "replyAll">(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const save = async () => {
    if (!reply) return;
    setSaving(true);
    setSaveError(null);
    try {
      const draft = await rpc.call("saveDraft", { hostId, kind: reply, replyTo: ref_, body: text });
      setDraftId(draft.id);
      setReply(null);
      setText("");
    } catch (cause) {
      setSaveError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!message) return <Notice tone="info">{t.opening}</Notice>;

  return (
    <article className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-base font-semibold break-words">{message.subject || t.noSubject}</h2>
        <p className="text-sm break-words">
          <span className="text-muted-foreground">{t.from} </span>
          {message.from ? formatAddress(message.from) : t.unknownSender}
        </p>
        <p className="text-sm break-words">
          <span className="text-muted-foreground">{t.to} </span>
          {message.to.map(formatAddress).join(", ") || t.nobodyListed}
        </p>
        {message.cc.length ? (
          <p className="text-sm break-words">
            <span className="text-muted-foreground">{t.cc} </span>
            {message.cc.map(formatAddress).join(", ")}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{message.received ? new Date(message.received).toLocaleString(intlLocale(lang)) : ""}</p>
        {message.attachments.length ? <p className="text-xs text-muted-foreground">{t.attachmentsInOutlook(message.attachments.map((a) => a.name).join(", "))}</p> : null}
      </header>

      {canReply ? (
        <div className="flex flex-wrap gap-2">
          <Button variant={reply === "reply" ? "secondary" : "outline"} size="sm" onClick={() => setReply("reply")}>
            {t.reply}
          </Button>
          <Button variant={reply === "replyAll" ? "secondary" : "outline"} size="sm" onClick={() => setReply("replyAll")}>
            {t.replyAll}
          </Button>
        </div>
      ) : null}

      {reply ? (
        <div className="space-y-2">
          <textarea className={textareaClass} rows={8} autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder={t.replyPlaceholder} />
          {saveError ? <Notice tone="error">{saveError}</Notice> : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()} disabled={saving || text.trim() === ""}>
              {saving ? t.saving : t.prepare}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReply(null)} disabled={saving}>
              {t.cancel}
            </Button>
          </div>
        </div>
      ) : null}

      {draftId ? <DraftCard rpc={rpc} target={{ hostId }} id={draftId} /> : null}

      <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-4 text-sm leading-relaxed">{message.body || t.emptyBody}</div>
    </article>
  );
}
