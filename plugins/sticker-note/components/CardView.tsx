// One sticker on the board.
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";

import { useLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { overdueMinutes } from "../src/board";
import type { LocalNow } from "../src/dates";
import { messages } from "../src/messages";
import type { Card, Column } from "../src/model";
import { doneText, linkLabel, shortWhen } from "./format";
import { Icon } from "./icons";

export const DRAG_TYPE = "application/x-sticker-note-card";

interface CardViewProps {
  card: Card;
  column: Column;
  now: LocalNow;
  flash: boolean;
  onOpen: (id: string) => void;
  onToggleDone: (card: Card) => void;
}

export function CardView({ card, column, now, flash, onOpen, onToggleDone }: CardViewProps) {
  const m = useMessages(messages);
  const lang = useLang();
  const late = overdueMinutes(card, now);
  const hasTime = column === "today" && card.due?.time != null;

  let when = null;
  if (column === "done") {
    const text = doneText(m, card.doneAt, now, lang);
    if (text) when = <span className="sn-done-at">{text}</span>;
  } else if (column === "today") {
    const lateNote = late > 0 ? <span className="sn-late-note">{late >= 60 ? m.overdueBy(Math.floor(late / 60)) : m.overdue}</span> : null;
    if (hasTime) {
      when = (
        <div className="sn-when">
          <span className={cn("sn-time", late > 0 && "late")}>{card.due!.time}</span>
          {lateNote}
        </div>
      );
    } else if (card.due && card.due.date < now.date) {
      when = (
        <div className="sn-when">
          <span>{shortWhen(m, card.due, now.date, lang)}</span>
          {lateNote}
        </div>
      );
    }
  } else if (card.due) {
    when = (
      <div className="sn-when">
        <span>{shortWhen(m, card.due, now.date, lang)}</span>
      </div>
    );
  }

  const meta =
    column === "done" ? null : (
      <>
        {card.links.map((link) => (
          <span key={link} className="sn-chip lnk">
            <Icon name="link" size={12} />
            {linkLabel(link)}
          </span>
        ))}
        {card.kind === "work" ? (
          <span className="sn-chip work">
            <Icon name="briefcase" size={12} />
            {m.workTag}
          </span>
        ) : null}
        {card.chats.length ? (
          <span className="sn-chip chat">
            <Icon name="chat" size={12} />
            {m.chatTag}
            {card.chats.length > 1 ? ` ${card.chats.length}` : ""}
          </span>
        ) : null}
        {card.notes.length ? (
          <span className="sn-chip" title={m.notesTag}>
            <Icon name="lines" size={12} />
            {card.notes.length}
          </span>
        ) : null}
      </>
    );

  const open = (event: MouseEvent | KeyboardEvent) => {
    if ((event.target as HTMLElement).closest(".sn-chk")) return;
    onOpen(card.id);
  };

  return (
    <article
      data-card-id={card.id}
      className={cn(
        "sn-card",
        `imp-${card.importance}`,
        column === "done" && "done",
        hasTime && "has-time",
        flash && "fresh",
      )}
      draggable
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) open(event);
      }}
      onDragStart={(event: DragEvent) => {
        event.dataTransfer.setData(DRAG_TYPE, card.id);
        event.dataTransfer.setData("text/plain", card.title);
        event.dataTransfer.effectAllowed = "move";
        (event.currentTarget as HTMLElement).classList.add("dragging");
      }}
      onDragEnd={(event) => (event.currentTarget as HTMLElement).classList.remove("dragging")}
    >
      <button
        type="button"
        className="sn-chk"
        aria-label={card.done ? m.markUndone : m.markDone}
        title={card.done ? m.markUndone : m.markDone}
        onClick={(event) => {
          event.stopPropagation();
          onToggleDone(card);
        }}
      >
        <Icon name="check" size={11} />
      </button>
      <span className="sn-num" aria-label={`#${card.num}`}>
        #{card.num}
      </span>
      {when}
      <div className="sn-title">{card.title}</div>
      {meta ? <div className="sn-meta">{meta}</div> : null}
    </article>
  );
}
