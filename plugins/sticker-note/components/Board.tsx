// The Sticker Note page: the dictation bar, one line about what was just done,
// four columns by time, and the open card.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useSettings, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

import { LanguageSwitch, messagesNow, useLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { DEFAULT_HOTKEY, hotkeyLabel, parseHotkey } from "../hooks/dictation";
import { errorText, useCards, type CardsRpc } from "../hooks/useCards";
import { useNow } from "../hooks/useNow";
import { filterStore, useStore, type Filter } from "../hooks/stores";
import { COLUMNS, columnOf, layoutToday, sortColumn } from "../src/board";
import { addDays, fullDay, localNow, type LocalNow } from "../src/dates";
import { messages } from "../src/messages";
import type { Card, Column } from "../src/model";
import { CaptureBar } from "./CaptureBar";
import { CardView, DRAG_TYPE, type QuickAction } from "./CardView";
import { Detail } from "./Detail";
import { columnName, type Messages } from "./format";
import { Icon } from "./icons";
import { addedText, commandText, whichText, type LogLine } from "./log";

/** Finished cards shown at most; older ones stay stored until pruned. */
const DONE_SHOWN = 40;
const FLASH_MS = 1800;
/** How long the last card you dealt with stays "the task" for "закрой задачу". */
const CONTEXT_MS = 15 * 60_000;

function passes(filter: Filter, card: Card): boolean {
  return filter === "all" || (filter === "work") === (card.kind === "work");
}

/** The hotkey from the plugin settings, as a hint label; null when it is off or unreadable. */
export function useHotkeyLabel(): string | null {
  const { values } = useSettings();
  const raw = values?.hotkey;
  const hotkey = parseHotkey(typeof raw === "string" ? raw : DEFAULT_HOTKEY);
  return hotkey ? hotkeyLabel(hotkey) : null;
}

export function BoardHeader(_props: PluginNavPanelProps) {
  const m = useMessages(messages);
  const { cards } = useCards();
  const filter = useStore(filterStore);
  const open = cards ? cards.filter((c) => !c.done).length : null;
  return (
    <div className="sn-head">
      {open !== null ? <span className="sn-head-count">{m.open(open)}</span> : null}
      <div className="sn-seg" role="group" aria-label={m.filterLabel}>
        {(["all", "work", "personal"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => filterStore.set(value)}>
            {{ all: m.filterAll, work: m.filterWork, personal: m.filterPersonal }[value]}
          </button>
        ))}
      </div>
      <LanguageSwitch />
    </div>
  );
}

function LogView({ log, onUndo }: { log: LogLine | null; onUndo: (token: string) => void }) {
  const m = useMessages(messages);
  return (
    <div className="sn-log-row" aria-live="polite">
      {log ? (
        <div key={log.at} className={cn("sn-log", log.tone)}>
          <Icon name={log.tone === "ok" ? "check" : "help"} size={13} />
          <span className="sn-log-text">{log.text}</span>
          {log.undoToken ? (
            <button type="button" className="sn-log-undo" onClick={() => onUndo(log.undoToken!)}>
              {m.undo}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function useLog(rpc: CardsRpc) {
  const [log, setLog] = useState<LogLine | null>(null);
  const say = useCallback((text: string, undoToken: string | null, tone: LogLine["tone"] = "ok") => {
    setLog({ text, undoToken, tone, at: Date.now() });
  }, []);
  const undo = useCallback(
    (token: string) => {
      rpc.call("undo", { token }).then(
        (result) => say(result.restored ? messagesNow(messages).logReverted : messagesNow(messages).logUndoGone, null),
        (cause: unknown) => toast.error(messagesNow(messages).error(errorText(cause))),
      );
    },
    [rpc, say],
  );
  return { log, say, undo };
}

export function BoardPage(_props: PluginNavPanelProps) {
  const m = useMessages(messages);
  const lang = useLang();
  const { rpc, cards, error, refetch } = useCards();
  const now = useNow();
  const filter = useStore(filterStore);
  const hotkey = useHotkeyLabel();
  const { log, say, undo } = useLog(rpc);
  const rootRef = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ids: string[]; at: number } | null>(null);
  const [dropColumn, setDropColumn] = useState<Column | null>(null);
  const context = useRef<{ id: string; at: number } | null>(null);
  const touch = useCallback((id: string) => {
    context.current = { id, at: Date.now() };
  }, []);

  const highlight = useCallback((ids: string[]) => setFlash({ ids, at: Date.now() }), []);

  const openCardById = useCallback(
    (id: string) => {
      touch(id);
      setOpenId(id);
    },
    [touch],
  );


  useEffect(() => {
    if (!flash) return;
    const first = flash.ids[0];
    if (first) rootRef.current?.querySelector(`[data-card-id="${CSS.escape(first)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const reveal = (card: Card) => {
    if (!passes(filterStore.get(), card)) filterStore.set("all");
    highlight([card.id]);
    touch(card.id);
  };

  const capture = async (text: string, spoken: boolean) => {
    const at = localNow();
    const recent = context.current && Date.now() - context.current.at < CONTEXT_MS ? context.current.id : null;
    const { parse, card, cards: touched, undoToken } = await rpc.call("capture", { text, now: at, spoken, contextId: recent });
    const t = messagesNow(messages);
    const list = cardsRef.current ?? [];
    switch (parse.type) {
      case "create":
        say(addedText(t, card!, at.date, lang), undoToken);
        reveal(card!);
        break;
      case "command":
        if (card && parse.action === "open") {
          openCardById(card.id);
          say(commandText(t, "open", card, at.date, lang), null);
        } else if (card) {
          say(commandText(t, parse.action, touched, at.date, lang), undoToken);
          if (parse.action === "delete") {
            if (openId && touched.some((c) => c.id === openId)) setOpenId(null);
            context.current = null;
          } else if (touched.length > 1) {
            if (touched.some((c) => !passes(filterStore.get(), c))) filterStore.set("all");
            highlight(touched.map((c) => c.id));
            context.current = null;
          } else reveal(card);
        }
        break;
      case "ambiguous": {
        const candidates = parse.candidateIds
          .map((id) => list.find((c) => c.id === id))
          .filter((c): c is Card => c !== undefined);
        say(whichText(t, candidates, lang), null, "ask");
        if (parse.candidateIds.length) filterStore.set("all");
        highlight(parse.candidateIds);
        break;
      }
      case "notFound":
        say(parse.named ? t.logNotFound : t.logUnnamed, null, "ask");
        break;
    }
    return parse.spans;
  };

  const toggleDone = useCallback(
    (card: Card) => {
      const t = messagesNow(messages);
      touch(card.id);
      rpc.call("card_update", { id: card.id, patch: { done: !card.done } }).then(
        (result) => say(commandText(t, card.done ? "undone" : "done", card, localNow().date, lang), result.undoToken),
        (cause: unknown) => toast.error(t.error(errorText(cause))),
      );
    },
    [rpc, say, touch, lang],
  );

  /** The small buttons on a card: tomorrow, important, delete. Each line in the log can be undone. */
  const quick = (card: Card, action: QuickAction) => {
    const t = messagesNow(messages);
    const at = localNow();
    const fail = (cause: unknown) => toast.error(t.error(errorText(cause)));
    if (action === "delete") {
      rpc.call("card_delete", { id: card.id }).then((result) => {
        say(commandText(t, "delete", card, at.date, lang), result.undoToken);
        if (openId === card.id) setOpenId(null);
        if (context.current?.id === card.id) context.current = null;
      }, fail);
      return;
    }
    touch(card.id);
    const patch =
      action === "tomorrow"
        ? { due: { date: addDays(at.date, 1), time: card.due?.time ?? null } }
        : { importance: card.importance === "high" ? ("normal" as const) : ("high" as const) };
    rpc.call("card_update", { id: card.id, patch }).then((result) => {
      say(commandText(t, action === "tomorrow" ? "move" : "importance", result.card ?? card, at.date, lang), result.undoToken);
      highlight([card.id]);
    }, fail);
  };

  const moveTo = (id: string, column: Column) => {
    const card = cards?.find((c) => c.id === id);
    if (!card || columnOf(card, now.date) === column) return;
    const t = messagesNow(messages);
    const at = localNow();
    touch(id);
    rpc.call("card_move", { id, column, now: at }).then(
      (result) => {
        const after = result.card ?? card;
        say(commandText(t, column === "done" ? "done" : "move", after, at.date, lang), result.undoToken);
        highlight([id]);
      },
      (cause: unknown) => toast.error(t.error(errorText(cause))),
    );
  };

  const grouped = useMemo(() => {
    const groups: Record<Column, Card[]> = { today: [], soon: [], later: [], done: [] };
    for (const card of cards ?? []) if (passes(filter, card)) groups[columnOf(card, now.date)].push(card);
    return groups;
  }, [cards, filter, now.date]);

  const openCard = openId ? (cards?.find((c) => c.id === openId) ?? null) : null;
  useEffect(() => {
    if (openId && cards && !openCard) setOpenId(null);
  }, [openId, cards, openCard]);

  const flashing = new Set(flash?.ids ?? []);

  const renderCard = (card: Card, column: Column) => (
    <CardView
      key={card.id}
      card={card}
      column={column}
      now={now}
      flash={flashing.has(card.id)}
      onOpen={openCardById}
      onToggleDone={toggleDone}
      onQuick={quick}
    />
  );

  const dropHandlers = (column: Column) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dropColumn !== column) setDropColumn(column);
    },
    onDragLeave: (event: DragEvent) => {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDropColumn(null);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDropColumn(null);
      const id = event.dataTransfer.getData(DRAG_TYPE);
      if (id) moveTo(id, column);
    },
  });

  const subtitle = (column: Column, today: LocalNow) =>
    ({ today: fullDay(today.date, lang), soon: m.subSoon, later: m.subLater, done: m.subDone })[column];

  return (
    <div ref={rootRef} className="sn-root">
      <CaptureBar
        variant="board"
        placeholder={m.placeholder}
        busyLabel={() => m.understanding}
        hotkeyTarget={!openCard}
        hotkeyLabel={hotkey}
        onText={capture}
      />
      <LogView log={log} onUndo={undo} />

      {error && !cards ? (
        <div className="sn-error">
          {m.loadFailed(error)}
          <button type="button" className="sn-btn sm" onClick={refetch}>
            {m.retry}
          </button>
        </div>
      ) : !cards ? (
        <div className="sn-loading">{m.loading}</div>
      ) : (
        <div className="sn-board">
          {COLUMNS.map((column) => {
            const list = grouped[column];
            return (
              <section key={column} className="sn-col" data-col={column} aria-label={columnName(m, column)}>
                <header className="sn-col-head">
                  <h3>{columnName(m, column)}</h3>
                  <span className="sn-count">{list.length}</span>
                  <span className="sn-csub">{subtitle(column, now)}</span>
                </header>
                <div className={cn("sn-col-body", dropColumn === column && "drop")} {...dropHandlers(column)}>
                  {column === "today" ? (
                    <TodayColumn cards={list} now={now} m={m} renderCard={renderCard} />
                  ) : (
                    <>
                      {sortColumn(column, list)
                        .slice(0, column === "done" ? DONE_SHOWN : undefined)
                        .map((card) => renderCard(card, column))}
                      {!list.length ? <div className="sn-empty">{column === "done" ? m.emptyDone : m.empty}</div> : null}
                    </>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {openCard ? (
        <Detail
          card={openCard}
          now={now}
          rpc={rpc}
          onClose={() => setOpenId(null)}
          onChanged={(text, undoToken) => say(text, undoToken)}
        />
      ) : null}
    </div>
  );
}

function TodayColumn({
  cards,
  now,
  m,
  renderCard,
}: {
  cards: Card[];
  now: LocalNow;
  m: Messages;
  renderCard: (card: Card, column: Column) => ReactNode;
}) {
  const { timed, nowIndex, untimed } = layoutToday(cards, now);
  return (
    <>
      {timed.slice(0, nowIndex).map((card) => renderCard(card, "today"))}
      <div className="sn-now">{m.now(now.time)}</div>
      {timed.slice(nowIndex).map((card) => renderCard(card, "today"))}
      {untimed.length ? (
        <>
          <div className="sn-subhead">{m.anyTime}</div>
          {untimed.map((card) => renderCard(card, "today"))}
        </>
      ) : null}
      {!cards.length ? <div className="sn-empty">{m.empty}</div> : null}
    </>
  );
}
