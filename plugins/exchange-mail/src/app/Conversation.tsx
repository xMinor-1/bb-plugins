// The other messages of the open message's conversation, oldest first, in
// Inbox and Sent Items. A row opens that message in place.
import { useEffect, useState } from "react";
import type { MessageSummary } from "../../contract";
import { defineMessages, intlLocale, pluralRu, useLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { shownName } from "./People";
import type { Rpc } from "./rpc";

const texts = defineMessages(
  {
    title: (n: number) => `Conversation, ${n} messages`,
    you: "you",
    noSubject: "(no subject)",
  },
  {
    title: (n) => `Переписка: ${n} ${pluralRu(n, ["письмо", "письма", "писем"])}`,
    you: "вы",
    noSubject: "(без темы)",
  },
);

export function Conversation({ rpc, hostId, messageRef, onOpen }: { rpc: Rpc; hostId: string; messageRef: string; onOpen: (ref: string) => void }) {
  const t = useMessages(texts);
  const lang = useLang();
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);

  useEffect(() => {
    let live = true;
    setMessages(null);
    // Nice to have: the open message shows without it if this fails.
    rpc.call("conversation", { hostId, ref: messageRef }).then(
      (result) => live && setMessages(result.messages),
      () => live && setMessages([]),
    );
    return () => {
      live = false;
    };
  }, [rpc, hostId, messageRef]);

  if (!messages || messages.length < 2) return null;
  return (
    <section className="space-y-1">
      <p className="text-xs text-muted-foreground">{t.title(messages.length)}</p>
      <ol className="divide-y divide-border rounded-lg border border-border">
        {messages.map((message) => {
          const current = message.ref === messageRef;
          const when = message.received ? new Date(message.received).toLocaleString(intlLocale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
          return (
            <li key={message.ref}>
              <button
                type="button"
                disabled={current}
                aria-current={current ? "true" : undefined}
                onClick={() => onOpen(message.ref)}
                className={cn("block w-full px-3 py-1.5 text-left text-xs hover:bg-state-hover disabled:cursor-default", current && "bg-state-active")}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate", !message.isRead && "font-semibold")}>{message.from ? shownName(message.from) : t.you}</span>
                  <span className="shrink-0 text-muted-foreground">{when}</span>
                </span>
                <span className="block truncate text-muted-foreground">{message.preview || message.subject || t.noSubject}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
