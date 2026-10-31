// An open card: fields, notes, agent chats, and a composer at the bottom that
// turns a phrase into a note or an agent chat.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { messagesNow, useLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import type { CardsRpc } from "../hooks/useCards";
import { columnOf } from "../src/board";
import { decide, isExplicitNote } from "../src/compose";
import { addDays, fullDay, localNow, type LocalNow } from "../src/dates";
import { messages } from "../src/messages";
import type { Card, Due, Importance, Kind } from "../src/model";
import { CaptureBar } from "./CaptureBar";
import { columnName, linkHref, linkLabel, shorten, whenText } from "./format";
import { Icon } from "./icons";
import { commandText, type LogLine } from "./log";

type Patch = {
  title?: string;
  importance?: Importance;
  kind?: Kind;
  due?: Due | null;
  links?: string[];
  notes?: string[];
  done?: boolean;
};

interface DetailProps {
  card: Card;
  now: LocalNow;
  rpc: CardsRpc;
  onClose: () => void;
  /** Shows the toast with Undo for a change. */
  onChanged: (text: string, undoToken: string | null) => void;
}

export function Detail({ card, now, rpc, onClose, onChanged }: DetailProps) {
  const m = useMessages(messages);
  const lang = useLang();
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLElement>(null);
  const [title, setTitle] = useState(card.title);
  const [link, setLink] = useState("");
  const [footLog, setFootLog] = useState<LogLine | null>(null);

  useEffect(() => setTitle(card.title), [card.id, card.title]);

  // Escape closes the card unless a field is being edited.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [card.id]);

  const update = async (patch: Patch, toastText?: string) => {
    try {
      const result = await rpc.call("card_update", { id: card.id, patch });
      if (toastText) onChanged(toastText, result.undoToken);
    } catch (cause) {
      toast.error(messagesNow(messages).error(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  const saveTitle = () => {
    const next = title.replace(/\s+/g, " ").trim();
    if (!next) setTitle(card.title);
    else if (next !== card.title) void update({ title: next });
  };

  const setDate = (date: string) => {
    if (!date) return void update({ due: null });
    void update({ due: { date, time: card.due?.time ?? null } });
  };
  const setTime = (time: string) => {
    void update({ due: { date: card.due?.date ?? now.date, time: time || null } });
  };

  const addLink = () => {
    const next = link.trim();
    if (!next) return;
    setLink("");
    if (!card.links.includes(next)) void update({ links: [...card.links, next] });
  };

  const remove = async () => {
    try {
      const result = await rpc.call("card_delete", { id: card.id });
      onClose();
      onChanged(messagesNow(messages).logDeleted(shorten(card.title, 60)), result.undoToken);
    } catch (cause) {
      toast.error(messagesNow(messages).error(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  const compose = async (text: string) => {
    const at = localNow();
    const result = await rpc.call("card_compose", { id: card.id, text, now: at });
    const t = messagesNow(messages);
    const line =
      result.decision === "command"
        ? commandText(t, result.action!, result.card ?? result.before, at.date, lang)
        : result.decision === "chat"
          ? t.logChat(shorten(result.text, 80))
          : t.logNote(shorten(result.text, 80));
    setFootLog({ text: line, tone: "ok", undoToken: result.undoToken, at: Date.now() });
    onChanged(line, result.undoToken);
    return null;
  };

  const column = columnOf(card, now.date);
  const where = card.due ? whenText(m, card.due, now.date, lang) : m.noDate;

  return (
    <>
      <div className="sn-scrim" onClick={onClose} />
      <aside ref={rootRef} className="sn-drawer" tabIndex={-1} aria-label={card.title}>
        <div className="sn-d-scroll">
          <div className="sn-d-top">
            <span className="sn-d-where">
              <span className="sn-d-num">#{card.num}</span>
              {columnName(m, column)}
              {column !== "done" ? <span className="sn-faint">· {where}</span> : null}
            </span>
            <button type="button" className="sn-icon-btn" aria-label={m.close} title={m.close} onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>

          <textarea
            className="sn-d-title"
            value={title}
            rows={1}
            aria-label={m.title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setTitle(card.title);
                event.currentTarget.blur();
              }
            }}
          />

          <dl className="sn-d-fields">
            <dt>{m.when}</dt>
            <dd>
              <input
                type="date"
                className="sn-field"
                value={card.due?.date ?? ""}
                aria-label={m.when}
                onChange={(event) => setDate(event.target.value)}
              />
              <input
                type="time"
                className="sn-field"
                value={card.due?.time ?? ""}
                aria-label={m.time}
                onChange={(event) => setTime(event.target.value)}
              />
              {card.due ? (
                <button type="button" className="sn-btn sm ghost" onClick={() => void update({ due: null })}>
                  {m.clear}
                </button>
              ) : null}
            </dd>

            <dt>{m.importance}</dt>
            <dd>
              <div className="sn-seg" role="group" aria-label={m.importance}>
                {(["high", "normal", "low"] as const).map((level) => (
                  <button
                    key={level}
                    type="button"
                    aria-pressed={card.importance === level}
                    onClick={() => card.importance !== level && void update({ importance: level })}
                  >
                    {{ high: m.impHigh, normal: m.impNormal, low: m.impLow }[level]}
                  </button>
                ))}
              </div>
            </dd>

            <dt>{m.kind}</dt>
            <dd>
              <div className="sn-seg" role="group" aria-label={m.kind}>
                {(["personal", "work"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={card.kind === kind}
                    onClick={() => card.kind !== kind && void update({ kind })}
                  >
                    {kind === "work" ? m.kindWork : m.kindPersonal}
                  </button>
                ))}
              </div>
            </dd>

            <dt>{m.links}</dt>
            <dd>
              {card.links.map((item) => (
                <span key={item} className="sn-chip lnk sn-link">
                  <a href={linkHref(item)} target="_blank" rel="noreferrer">
                    <Icon name="link" size={12} />
                    {linkLabel(item)}
                  </a>
                  <button
                    type="button"
                    aria-label={m.remove}
                    title={m.remove}
                    onClick={() => void update({ links: card.links.filter((l) => l !== item) })}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
              <input
                className="sn-field ghost sn-link-input"
                value={link}
                placeholder={m.linkPlaceholder}
                aria-label={m.addLink}
                onChange={(event) => setLink(event.target.value)}
                onBlur={addLink}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addLink();
                  }
                }}
              />
            </dd>
          </dl>

          <section className="sn-blk">
            <div className="sn-lbl">{m.notes}</div>
            {card.notes.length ? (
              <ul className="sn-notes">
                {card.notes.map((note, i) => (
                  <li key={`${i}-${note}`}>
                    <span>{note}</span>
                    <button
                      type="button"
                      aria-label={m.remove}
                      title={m.remove}
                      onClick={() => void update({ notes: card.notes.filter((_, j) => j !== i) })}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="sn-ph">{m.notesEmpty}</div>
            )}
          </section>

          {card.chats.length ? (
            <section className="sn-blk">
              <div className="sn-lbl">{m.chats}</div>
              {card.chats.map((chat) => (
                <div key={chat.id} className="sn-chatb">
                  <div className="sn-chatb-head">
                    <Icon name="chat" size={14} />
                    <b>{m.chatTag}</b>
                    <span className={cn("sn-pill", chat.error && "err")}>
                      {chat.threadId ? m.chatRunning : chat.error ? m.chatFailedShort : m.chatStarting}
                    </span>
                  </div>
                  <p>{chat.text}</p>
                  {chat.error ? <div className="sn-chat-err">{m.chatFailed(chat.error)}</div> : null}
                  {chat.threadId ? (
                    <div className="sn-row">
                      <button type="button" className="sn-btn sm" onClick={() => navigate.toThread(chat.threadId!)}>
                        {m.chatOpen}
                        <Icon name="arrow" size={13} />
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}

          {card.said ? (
            <section className="sn-blk">
              <div className="sn-lbl">{m.said}</div>
              <p className="sn-said">{lang === "ru" ? `«${card.said}»` : `“${card.said}”`}</p>
            </section>
          ) : null}

          <div className="sn-d-actions">
            <button
              type="button"
              className="sn-btn primary"
              onClick={() =>
                void update(
                  { done: !card.done },
                  commandText(messagesNow(messages), card.done ? "undone" : "done", card, now.date, lang),
                )
              }
            >
              <Icon name="check" size={14} />
              {card.done ? m.markUndone : m.markDone}
            </button>
            {!card.done ? (
              <button
                type="button"
                className="sn-btn"
                onClick={() => {
                  const due = { date: addDays(now.date, 1), time: card.due?.time ?? null };
                  void update({ due }, commandText(messagesNow(messages), "move", { ...card, due }, now.date, lang));
                }}
              >
                <Icon name="calendar" size={14} />
                {m.toTomorrow}
              </button>
            ) : null}
            <button type="button" className="sn-btn ghost danger" onClick={() => void remove()}>
              <Icon name="trash" size={14} />
              {m.delete}
            </button>
            <span className="sn-created">{m.created(fullDay(localNow(new Date(card.createdAt)).date, lang))}</span>
          </div>
        </div>

        <div className="sn-cmp-wrap">
          <CaptureBar
            key={card.id}
            variant="composer"
            placeholder={m.composer}
            busyLabel={(text) =>
              isExplicitNote(text) ? m.decNotes : decide(text).type === "chat" ? m.decChat : m.understanding
            }
            hotkeyTarget
            hotkeyLabel={null}
            onText={compose}
          />
          {footLog ? (
            <div key={footLog.at} className="sn-cmp-foot sn-log ok">
              <Icon name="check" size={13} />
              <span className="sn-log-text">{footLog.text}</span>
            </div>
          ) : (
            <div className="sn-cmp-foot">{m.composerHint}</div>
          )}
        </div>
      </aside>
    </>
  );
}
