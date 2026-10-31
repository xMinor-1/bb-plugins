// The Sticker Note page: the dictation bar, what was understood, four
// columns by time, and the open card.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

import { LanguageSwitch, messagesNow, useLang, useMessages, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { errorText, useCards, type CardsRpc } from "../hooks/useCards";
import { useNow } from "../hooks/useNow";
import { filterStore, useStore, type Filter } from "../hooks/stores";
import { COLUMNS, columnOf, layoutToday, sortColumn } from "../src/board";
import { fullDay, localNow, type LocalNow } from "../src/dates";
import { messages } from "../src/messages";
import type { Action, Card, Column, ParseResult } from "../src/model";
import { CaptureBar } from "./CaptureBar";
import { CardView, DRAG_TYPE } from "./CardView";
import { Detail } from "./Detail";
import { columnName, importanceName, linkLabel, shorten, whenText, type Messages } from "./format";

/** Finished cards shown at most; older ones stay stored until pruned. */
const DONE_SHOWN = 40;
const FLASH_MS = 1800;
const CHIPS_MS = 6000;

type ChipKind = "when" | "imp" | "work" | "link" | "act" | "target";
interface Chip {
  kind: ChipKind;
  text: string;
}

function passes(filter: Filter, card: Card): boolean {
  return filter === "all" || (filter === "work") === (card.kind === "work");
}

function actionName(m: Messages, action: Action) {
  return { done: m.actDone, undone: m.actUndone, move: m.actMove, importance: m.actImportance, delete: m.actDelete }[action];
}

function chipsFor(m: Messages, parse: ParseResult, card: Card | null, cards: Card[], today: string, lang: Lang): Chip[] {
  if (parse.type === "create") {
    const { draft } = parse;
    const chips: Chip[] = [{ kind: "when", text: draft.due ? whenText(m, draft.due, today, lang) : m.chipNoDate }];
    if (draft.importance === "high") chips.push({ kind: "imp", text: m.chipImportant });
    if (draft.importance === "low") chips.push({ kind: "imp", text: m.chipLow });
    if (draft.kind === "work") chips.push({ kind: "work", text: m.chipWork });
    for (const link of draft.links) chips.push({ kind: "link", text: linkLabel(link) });
    return chips;
  }
  const chips: Chip[] = [{ kind: "act", text: actionName(m, parse.action) }];
  if (parse.type === "command") {
    const target = card ?? cards.find((c) => c.id === parse.targetId);
    if (target) chips.push({ kind: "target", text: shorten(target.title, 48) });
    if (parse.action === "move") chips.push({ kind: "when", text: parse.due ? whenText(m, parse.due, today, lang) : m.chipNoDate });
    if (parse.action === "importance" && parse.importance) chips.push({ kind: "imp", text: importanceName(m, parse.importance) });
  }
  return chips;
}

export function useNotify(rpc: CardsRpc) {
  return useCallback(
    (text: string, undoToken: string | null) => {
      if (!undoToken) return void toast(text);
      toast(text, {
        action: {
          label: messagesNow(messages).undo,
          onClick: () => {
            rpc.call("undo", { token: undoToken }).catch((cause: unknown) => {
              toast.error(messagesNow(messages).error(errorText(cause)));
            });
          },
        },
      });
    },
    [rpc],
  );
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

export function BoardPage(_props: PluginNavPanelProps) {
  const m = useMessages(messages);
  const lang = useLang();
  const { rpc, cards, error, refetch } = useCards();
  const now = useNow();
  const filter = useStore(filterStore);
  const notify = useNotify(rpc);
  const rootRef = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ids: string[]; at: number } | null>(null);
  const [chips, setChips] = useState<{ list: Chip[]; at: number } | null>(null);
  const [dropColumn, setDropColumn] = useState<Column | null>(null);

  const highlight = useCallback((ids: string[]) => setFlash({ ids, at: Date.now() }), []);

  useEffect(() => {
    if (!flash) return;
    const first = flash.ids[0];
    if (first) rootRef.current?.querySelector(`[data-card-id="${CSS.escape(first)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    if (!chips) return;
    const timer = window.setTimeout(() => setChips(null), CHIPS_MS);
    return () => window.clearTimeout(timer);
  }, [chips]);

  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const capture = async (text: string, spoken: boolean) => {
    const at = localNow();
    const { parse, card, undoToken } = await rpc.call("capture", { text, now: at, spoken });
    const t = messagesNow(messages);
    const list = cardsRef.current ?? [];
    setChips({ list: chipsFor(t, parse, card, list, at.date, lang), at: Date.now() });
    const reveal = (target: Card | null) => {
      if (target && !passes(filterStore.get(), target)) filterStore.set("all");
      if (target) highlight([target.id]);
    };
    switch (parse.type) {
      case "create":
        notify(t.added(columnName(t, columnOf(card!, at.date))), undoToken);
        reveal(card);
        break;
      case "command": {
        const title = shorten(card?.title ?? "", 40);
        const text = {
          done: t.markedTitle(title),
          undone: t.reopened,
          move: card?.due ? t.movedTo(whenText(t, card.due, at.date, lang)) : t.movedCol(t.colLater),
          importance: t.importanceSet(importanceName(t, card?.importance ?? "high").toLowerCase()),
          delete: t.deleted,
        }[parse.action];
        notify(text, undoToken);
        if (parse.action !== "delete") reveal(card);
        if (openId === parse.targetId && parse.action === "delete") setOpenId(null);
        break;
      }
      case "ambiguous": {
        const titles = parse.candidateIds
          .map((id) => list.find((c) => c.id === id)?.title)
          .filter((x): x is string => Boolean(x))
          .map((x) => `«${shorten(x, 30)}»`)
          .join(lang === "ru" ? " или " : " or ");
        toast(t.whichOne(titles));
        if (parse.candidateIds.length) filterStore.set("all");
        highlight(parse.candidateIds);
        break;
      }
      case "notFound":
        toast(t.notFound);
        break;
    }
    return parse.spans;
  };

  const toggleDone = useCallback(
    (card: Card) => {
      const t = messagesNow(messages);
      rpc.call("card_update", { id: card.id, patch: { done: !card.done } }).then(
        (result) => notify(card.done ? t.reopened : t.marked, result.undoToken),
        (cause: unknown) => toast.error(t.error(errorText(cause))),
      );
    },
    [rpc, notify],
  );

  const moveTo = (id: string, column: Column) => {
    const card = cards?.find((c) => c.id === id);
    if (!card || columnOf(card, now.date) === column) return;
    const t = messagesNow(messages);
    rpc.call("card_move", { id, column, now: localNow() }).then(
      (result) => {
        notify(column === "done" ? t.marked : t.movedCol(columnName(t, column)), result.undoToken);
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
      onOpen={setOpenId}
      onToggleDone={toggleDone}
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

  const subtitle = (column: Column, now: LocalNow) =>
    ({ today: fullDay(now.date, lang), soon: m.subSoon, later: m.subLater, done: m.subDone })[column];

  return (
    <div ref={rootRef} className="sn-root">
      <CaptureBar
        variant="board"
        placeholder={m.placeholder}
        busyLabel={() => m.understanding}
        spaceScope={openCard ? null : rootRef}
        onText={capture}
      />
      <div className="sn-parsed" aria-live="polite">
        {chips?.list.map((chip, i) => (
          <span key={`${chips.at}-${i}`} className={cn("sn-pchip", `k-${chip.kind}`)} style={{ animationDelay: `${i * 90}ms` }}>
            <i />
            {chip.text}
          </span>
        ))}
      </div>

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
        <Detail card={openCard} now={now} rpc={rpc} onClose={() => setOpenId(null)} onChanged={notify} />
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
  const line = (
    <div key="now" className="sn-now">
      {m.now(now.time)}
    </div>
  );
  return (
    <>
      {timed.slice(0, nowIndex).map((card) => renderCard(card, "today"))}
      {line}
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
