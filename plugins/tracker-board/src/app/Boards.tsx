// "My boards": the board list in the title bar, the star beside it, the settings
// section and the first-run step "What are you interested in".
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import { isPinned, moveBoard, myBoards, restoreBoard, setHidden, togglePinned, type BoardEntry } from "../shared/boards";
import { splitPrefix, type Issue, type Kind } from "../shared/model";
import { sourceFromText, sourceId, type Prefs, type SavedBoard, type Source } from "../shared/prefs";
import type { ConfigView, QueueView, Suggestions } from "../server/rpc-contract";
import type { Messages } from "./messages";
import { Avatar, Icons, TypeTile } from "./parts";
import { boardStore, errorText, loadBoard, prefsStore, savePrefs, settingsOpenStore, type Rpc } from "./store";
import { Popover, Spinner } from "./ui";

/** A board as the lists show it. */
export interface BoardItem {
  source: Source;
  title: string;
  kind?: Kind;
}

export const issueItem = (issue: Issue): BoardItem => ({ source: { kind: "issue", key: issue.key }, title: `${issue.key} ${splitPrefix(issue.summary).rest}`, kind: issue.kind });
const queueItem = (queue: QueueView): BoardItem => ({ source: { kind: "queue", queue: queue.key }, title: queue.name });

/** A board's key and name for a row; an issue board's title starts with its key. */
export function boardLabel(t: Messages, item: BoardItem): { key: string | null; name: string } {
  switch (item.source.kind) {
    case "queue": {
      const key = item.source.queue;
      return item.title && item.title !== key ? { key, name: item.title } : { key: null, name: key };
    }
    case "issue": {
      const key = item.source.key;
      const rest = item.title.startsWith(key) ? item.title.slice(key.length).trim() : item.title;
      return rest ? { key, name: rest } : { key: null, name: key };
    }
    case "query":
      return { key: null, name: item.title || item.source.query };
    case "mine":
      return { key: null, name: t.mine };
  }
}

/** A build's board nobody touched has no title yet: take it from recent boards or the board in view. */
function named(entry: BoardEntry, prefs: Prefs, current: BoardItem | null): BoardItem {
  if (entry.title) return entry;
  const known = prefs.recent.find((item) => sourceId(item.source) === entry.id) ?? (current && sourceId(current.source) === entry.id ? current : null);
  return known ? { source: entry.source, title: known.title, kind: entry.kind ?? known.kind } : entry;
}

export function BoardIcon({ t, item }: { t: Messages; item: BoardItem }) {
  switch (item.source.kind) {
    case "queue":
      return <span className="tb-ty tb-ty-q">Q</span>;
    case "issue":
      return item.kind ? <TypeTile kind={item.kind} t={t} /> : <span className="tb-ty tb-ty-ghost" />;
    case "query":
      return (
        <span className="tb-br-ic">
          <Icons.search />
        </span>
      );
    case "mine":
      return <Avatar id="me" name="Me" size={16} t={t} />;
  }
}

function save(rpc: Rpc, t: Messages, patch: Partial<Prefs>): void {
  savePrefs(rpc, patch).catch((cause) => toast.error(errorText(t, cause)));
}

const savedOf = (item: BoardItem): SavedBoard => ({ source: item.source, title: item.title, ...(item.kind ? { kind: item.kind } : {}), hidden: false });

/**
 * The star: pins a board or takes it away, with an undo that touches this board only.
 * A build's board is not removed: a hidden one comes back, a shown one says where to hide it.
 */
export function togglePin(t: Messages, rpc: Rpc, defaults: readonly Source[], item: BoardItem): void {
  const prefs = prefsStore.get();
  if (!prefs) return;
  const entries = myBoards(defaults, prefs.boards);
  const latest = () => myBoards(defaults, prefsStore.get()?.boards ?? []);
  const id = sourceId(item.source);
  const index = entries.findIndex((entry) => entry.id === id);
  const found = entries[index];
  const name = boardLabel(t, found ? named(found, prefs, item) : item).name;
  if (found?.build && !found.hidden) {
    toast(t.buildPinHint);
    return;
  }
  if (found?.build) {
    save(rpc, t, { boards: setHidden(entries, id, false) });
    toast.success(t.shownAgain(name), { action: { label: t.undo, onClick: () => save(rpc, t, { boards: setHidden(latest(), id, true) }) } });
    return;
  }
  if (found) {
    const before = entries[index + 1]?.id ?? null;
    save(rpc, t, { boards: togglePinned(entries, item.source, item.title) });
    toast.success(t.unpinned(name), { action: { label: t.undo, onClick: () => save(rpc, t, { boards: restoreBoard(latest(), found, before) }) } });
    return;
  }
  save(rpc, t, { boards: togglePinned(entries, item.source, item.title, item.kind) });
  toast.success(t.pinned(name), {
    action: {
      label: t.undo,
      onClick: () => {
        const now = latest();
        if (now.some((entry) => entry.id === id && !entry.build)) save(rpc, t, { boards: togglePinned(now, item.source, item.title) });
      },
    },
  });
}

interface SearchResult {
  text: string;
  queues: QueueView[];
  issues: Issue[];
  busy: boolean;
}

const NO_RESULT: SearchResult = { text: "", queues: [], issues: [], busy: false };

/** Queues by name or key and issues by key or title, for what the person typed. */
function useBoardSearch(rpc: Rpc, config: ConfigView, text: string): SearchResult {
  const [result, setResult] = useState<SearchResult>(NO_RESULT);
  const request = useRef(0);
  useEffect(() => {
    const trimmed = text.trim();
    const id = ++request.current;
    if (trimmed.length < 2) {
      setResult(NO_RESULT);
      return;
    }
    setResult((current) => ({ ...current, busy: true }));
    const asKey = sourceFromText(trimmed, false)?.kind === "issue";
    const timer = setTimeout(() => {
      void Promise.all([
        config.can.queues && !asKey ? rpc.call("queues", { text: trimmed }).then(({ queues }) => queues.slice(0, 8), () => []) : Promise.resolve([]),
        rpc.call("find", { text: trimmed }).then(({ issues }) => issues.slice(0, 12), () => []),
      ]).then(([queues, issues]) => {
        if (id === request.current) setResult({ text: trimmed, queues, issues, busy: false });
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [text, rpc, config.can.queues]);
  return result;
}

interface Row {
  /** A heading above the row when it changes; an empty string draws a line. */
  group: string;
  item: BoardItem;
  note?: string;
}

/** Search results by kind: a key or a link first and alone, then queues, epics, stories, tasks. */
function searchRows(t: Messages, config: ConfigView, text: string, found: SearchResult): Row[] {
  const parsed = sourceFromText(text, config.allowQuery);
  const fresh = found.text === text;
  const issues = fresh ? found.issues : [];
  const queues = fresh ? found.queues : [];
  if (parsed?.kind === "issue") {
    const hit = issues.find((issue) => issue.key === parsed.key);
    return [{ group: text.includes("/") ? t.fromLink : t.byKey, item: hit ? issueItem(hit) : { source: parsed, title: parsed.key }, note: hit ? undefined : t.keyNote }];
  }
  const rows: Row[] = queues.map((queue) => ({ group: t.groupQueues, item: queueItem(queue) }));
  // Any latin word reads as a queue key. Offer it only when the tracker cannot search queues,
  // or when the search found nothing else: otherwise "card" would offer a queue CARD.
  const lastResort = !config.can.queues || (fresh && !found.busy && queues.length === 0 && issues.length === 0);
  if (parsed?.kind === "queue" && lastResort && !queues.some((queue) => queue.key === parsed.queue)) rows.push({ group: t.groupQueues, item: { source: parsed, title: parsed.queue }, note: t.queueByKey });
  const kinds: [Kind[], string][] = [
    [["epic"], t.groupEpics],
    [["story"], t.groupStories],
    [["task", "bug"], t.groupTasks],
  ];
  for (const [these, group] of kinds) for (const issue of issues) if (these.includes(issue.kind)) rows.push({ group, item: issueItem(issue) });
  if (parsed?.kind === "query") rows.push({ group: "", item: { source: parsed, title: text }, note: t.queryItem });
  return rows;
}

/** Drag rows to reorder them, or move one with the arrow keys on its handle. */
function useReorder(ids: readonly string[], onMove: (id: string, before: string | null) => void, list: RefObject<HTMLElement | null>) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const end = () => {
    setDrag(null);
    setOver(null);
  };
  const refocus = (id: string) =>
    requestAnimationFrame(() => {
      for (const handle of Array.from(list.current?.querySelectorAll<HTMLElement>("[data-handle]") ?? [])) if (handle.dataset.handle === id) handle.focus();
    });
  return {
    rowClass: (id: string) => (drag === id ? " tb-br-drag" : over?.id === id && drag ? (over.after ? " tb-br-over-bot" : " tb-br-over-top") : ""),
    rowProps: (id: string) => ({
      draggable: true,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        setDrag(id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!drag) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        const after = event.clientY > box.top + box.height / 2;
        setOver((current) => (current?.id === id && current.after === after ? current : { id, after }));
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        if (drag && over) {
          const at = ids.indexOf(over.id);
          onMove(drag, over.after ? (ids[at + 1] ?? null) : over.id);
        }
        end();
      },
      onDragEnd: end,
    }),
    onKey: (id: string, event: KeyboardEvent) => {
      const at = ids.indexOf(id);
      if (event.key === "ArrowUp" && at > 0) onMove(id, ids[at - 1]!);
      else if (event.key === "ArrowDown" && at >= 0 && at < ids.length - 1) onMove(id, ids[at + 2] ?? null);
      else return;
      event.preventDefault();
      refocus(id);
    },
  };
}

function BoardRow({
  t,
  item,
  entry,
  note,
  current,
  highlighted,
  className,
  onOpen,
  lead,
  tail,
  rowProps,
}: {
  t: Messages;
  item: BoardItem;
  entry?: BoardEntry | null;
  note?: string;
  current?: boolean;
  highlighted?: boolean;
  className?: string;
  onOpen?: () => void;
  lead?: ReactNode;
  tail?: ReactNode;
  rowProps?: Record<string, unknown>;
}) {
  const label = boardLabel(t, item);
  const inner = (
    <>
      <BoardIcon t={t} item={item} />
      {label.key ? <span className="tb-k">{label.key}</span> : null}
      <span className="tb-t" title={label.name}>
        {label.name}
      </span>
      {current ? <span className="tb-br-note">{t.openNow}</span> : null}
      {note ? <span className="tb-br-note">{note}</span> : null}
    </>
  );
  return (
    <div className={`tb-br${highlighted ? " tb-br-hl" : ""}${current ? " tb-br-cur" : ""}${entry?.hidden ? " tb-br-hid" : ""}${className ?? ""}`} {...rowProps}>
      {lead}
      {onOpen ? (
        <button className="tb-br-main" type="button" onClick={onOpen} tabIndex={-1}>
          {inner}
        </button>
      ) : (
        <span className="tb-br-main">{inner}</span>
      )}
      {entry?.build ? (
        <span className="tb-tag" title={t.buildTagHint}>
          <Icons.lock />
          {t.buildTag}
        </span>
      ) : null}
      {tail}
    </div>
  );
}

function Star({ t, entry, onClick }: { t: Messages; entry: BoardEntry | null; onClick: () => void }) {
  const on = Boolean(entry && !entry.hidden);
  const hint = on ? (entry?.build ? t.buildPinHint : t.unpin) : t.pin;
  return (
    <button
      className={`tb-br-act${on ? " tb-star-on" : ""}`}
      type="button"
      title={hint}
      aria-label={hint}
      aria-pressed={on}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icons.star on={on} />
    </button>
  );
}

function Handle({ t, id, onKey }: { t: Messages; id: string; onKey: (id: string, event: KeyboardEvent) => void }) {
  return (
    <button className="tb-handle" type="button" data-handle={id} title={t.moveBoard} aria-label={t.moveBoard} onKeyDown={(event) => onKey(id, event)} onClick={(event) => event.stopPropagation()}>
      <Icons.grip />
    </button>
  );
}

/** Rows under their group headings. */
function Grouped({ rows, head, render }: { rows: Row[]; head?: (group: string) => ReactNode; render: (row: Row, index: number) => ReactNode }) {
  const out: ReactNode[] = [];
  let last: string | null = null;
  rows.forEach((row, index) => {
    if (row.group !== last) {
      out.push(
        row.group === "" ? (
          <div key={`g${index}`} className="tb-sep" />
        ) : (
          <div key={`g${index}`} className="tb-grp">
            {row.group}
            {head ? head(row.group) : null}
          </div>
        ),
      );
      last = row.group;
    }
    out.push(render(row, index));
  });
  return <>{out}</>;
}

/** The star beside the board's name in the title bar. */
export function HeaderStar({ t, rpc, config, prefs, item }: { t: Messages; rpc: Rpc; config: ConfigView; prefs: Prefs; item: BoardItem }) {
  if (item.source.kind === "mine") return null;
  const entry = isPinned(myBoards(config.defaultBoards, prefs.boards), item.source);
  const on = Boolean(entry && !entry.hidden);
  const hint = on ? (entry?.build ? t.buildPinHint : t.unpin) : t.pin;
  return (
    <button className={`tb-hstar tb-ph-opt${on ? " tb-star-on" : ""}`} type="button" title={hint} aria-label={hint} aria-pressed={on} onClick={() => togglePin(t, rpc, config.defaultBoards, item)}>
      <Icons.star on={on} />
    </button>
  );
}

/** The board list in the title bar: my boards, assigned to me, recent, and search. */
export function SourcePicker({ t, rpc, config, prefs, current, onPick }: { t: Messages; rpc: Rpc; config: ConfigView; prefs: Prefs; current: BoardItem | null; onPick: (source: Source) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [hl, setHl] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const trimmed = text.trim();
  const found = useBoardSearch(rpc, config, open ? text : "");
  const entries = useMemo(() => myBoards(config.defaultBoards, prefs.boards), [config.defaultBoards, prefs.boards]);
  const shown = entries.filter((entry) => !entry.hidden);
  const reorder = useReorder(
    shown.map((entry) => entry.id),
    (id, before) => save(rpc, t, { boards: moveBoard(entries, id, before) }),
    list,
  );
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);
  useEffect(() => setHl(0), [trimmed]);
  useEffect(() => {
    list.current?.querySelector(".tb-br-hl")?.scrollIntoView({ block: "nearest" });
  }, [hl]);

  const shownIds = new Set(shown.map((entry) => entry.id));
  const rows: Row[] = trimmed
    ? searchRows(t, config, trimmed, found)
    : [
        ...shown.map((entry) => ({ group: t.myBoards, item: named(entry, prefs, current) })),
        ...(config.can.mine && !shownIds.has("mine") ? [{ group: "", item: { source: { kind: "mine" } as Source, title: "" } }] : []),
        ...prefs.recent.filter((item) => item.source.kind !== "mine" && !shownIds.has(sourceId(item.source))).map((item) => ({ group: t.recent, item })),
      ];
  const currentId = current ? sourceId(current.source) : null;
  const pick = (source: Source) => {
    setOpen(false);
    setText("");
    onPick(source);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length) setHl((at) => (event.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)));
    } else if (event.key === "Enter") {
      const row = rows[hl];
      if (row) pick(row.item.source);
      else {
        const parsed = sourceFromText(trimmed, config.allowQuery);
        if (parsed) pick(parsed);
      }
    } else if (event.key === "Escape") setOpen(false);
  };
  const label = current ? boardLabel(t, current) : null;
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      className="tb-src-pop"
      trigger={
        <button className="tb-src" type="button" onClick={() => setOpen(!open)} title={t.source} aria-expanded={open}>
          {current ? <BoardIcon t={t} item={current} /> : null}
          {label?.key ? <span className="tb-k">{label.key}</span> : null}
          <span className="tb-t">{label?.name ?? t.source}</span>
          <Icons.chevD />
        </button>
      }
    >
      <input ref={input} className="tb-pin" placeholder={t.pickerPlaceholder} aria-label={t.pickerPlaceholder} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
      <div ref={list} role="listbox" aria-label={t.source}>
        <Grouped
          rows={rows}
          head={(group) =>
            group === t.myBoards && !trimmed ? (
              <>
                <span className="tb-grow" />
                <button
                  className="tb-lnk"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    settingsOpenStore.set(true);
                  }}
                >
                  {t.setUpBoards}
                </button>
              </>
            ) : null
          }
          render={(row, index) => {
            const id = sourceId(row.item.source);
            const entry = isPinned(entries, row.item.source);
            const mine = row.group === t.myBoards && !trimmed;
            return (
              <BoardRow
                key={`${row.group}:${id}`}
                t={t}
                item={entry ? named(entry, prefs, row.item) : row.item}
                entry={entry && !entry.hidden ? entry : null}
                note={row.note}
                current={id === currentId}
                highlighted={index === hl}
                className={mine ? reorder.rowClass(id) : ""}
                rowProps={{ role: "option", "aria-selected": index === hl, onMouseMove: () => index !== hl && setHl(index), ...(mine ? reorder.rowProps(id) : {}) }}
                onOpen={() => pick(row.item.source)}
                lead={mine ? <Handle t={t} id={id} onKey={reorder.onKey} /> : null}
                tail={row.item.source.kind === "mine" ? null : <Star t={t} entry={entry} onClick={() => togglePin(t, rpc, config.defaultBoards, row.item)} />}
              />
            );
          }}
        />
        {trimmed.length >= 2 && found.busy && rows.length === 0 ? (
          <div className="tb-mh">
            <Spinner />
          </div>
        ) : null}
        {trimmed.length >= 2 && !found.busy && found.text === trimmed && rows.length === 0 ? <div className="tb-mh">{t.nothingFoundBoards}</div> : null}
      </div>
      <div className="tb-sep" />
      <div className="tb-keys">{t.pickerKeys}</div>
    </Popover>
  );
}

/** Settings, "My boards": the order, hiding a build's board, removing and adding one's own. */
export function BoardsSection({ t, rpc, config, prefs }: { t: Messages; rpc: Rpc; config: ConfigView; prefs: Prefs }) {
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement | null>(null);
  const found = useBoardSearch(rpc, config, text);
  const entries = useMemo(() => myBoards(config.defaultBoards, prefs.boards), [config.defaultBoards, prefs.boards]);
  const reorder = useReorder(
    entries.map((entry) => entry.id),
    (id, before) => save(rpc, t, { boards: moveBoard(entries, id, before) }),
    list,
  );
  const trimmed = text.trim();
  const rows = trimmed ? searchRows(t, config, trimmed, found) : [];
  return (
    <section>
      <h3>{t.settingsBoards}</h3>
      <p className="tb-h">{t.settingsBoardsHint}</p>
      <div className="tb-blist" ref={list}>
        {entries.length === 0 ? <p className="tb-hint tb-blist-empty">{t.noBoards}</p> : null}
        {entries.map((entry) => (
          <BoardRow
            key={entry.id}
            t={t}
            item={named(entry, prefs, null)}
            entry={entry}
            className={reorder.rowClass(entry.id)}
            rowProps={reorder.rowProps(entry.id)}
            lead={<Handle t={t} id={entry.id} onKey={reorder.onKey} />}
            tail={
              entry.build ? (
                <button
                  className="tb-br-act"
                  type="button"
                  title={entry.hidden ? t.showBoard : t.hideBoard}
                  aria-label={entry.hidden ? t.showBoard : t.hideBoard}
                  aria-pressed={!entry.hidden}
                  onClick={() => save(rpc, t, { boards: setHidden(entries, entry.id, !entry.hidden) })}
                >
                  <Icons.eye on={!entry.hidden} />
                </button>
              ) : (
                <Star t={t} entry={entry} onClick={() => togglePin(t, rpc, config.defaultBoards, entry)} />
              )
            }
          />
        ))}
      </div>
      <label className="tb-bigsearch tb-bigsearch-s">
        <Icons.plus />
        <input value={text} placeholder={t.addBoardPlaceholder} aria-label={t.addBoardPlaceholder} onChange={(event) => setText(event.target.value)} />
        {found.busy ? <Spinner /> : null}
      </label>
      {rows.length > 0 ? (
        <div className="tb-results">
          <Grouped
            rows={rows}
            render={(row) => {
              const entry = isPinned(entries, row.item.source);
              return <BoardRow key={`${row.group}:${sourceId(row.item.source)}`} t={t} item={row.item} note={row.note} tail={<Star t={t} entry={entry} onClick={() => togglePin(t, rpc, config.defaultBoards, row.item)} />} />;
            }}
          />
        </div>
      ) : trimmed.length >= 2 && !found.busy && found.text === trimmed ? (
        <p className="tb-hint">{t.nothingFoundBoards}</p>
      ) : null}
      {config.defaultBoards.length > 0 ? <p className="tb-hint tb-blist-foot">{t.boardsBuildHint}</p> : null}
    </section>
  );
}

/** Whether the page shows "What are you interested in" instead of a board. */
export const needsInterest = (config: ConfigView, prefs: Prefs): boolean => !config.problem && !prefs.boardsReady && prefs.boards.length === 0;

function Steps({ t, keyDone }: { t: Messages; keyDone: boolean }) {
  return (
    <div className="tb-steps">
      <span className={keyDone ? "tb-step-ok" : "tb-step-now"}>
        <span className="tb-step-n">{keyDone ? <Icons.check /> : 1}</span>
        {t.stepKey}
      </span>
      <span className={keyDone ? "tb-step-now" : ""}>
        <span className="tb-step-n">2</span>
        {t.stepInterest}
      </span>
      <span>
        <span className="tb-step-n">3</span>
        {t.stepBoard}
      </span>
    </div>
  );
}

/** The first run after the key: mark the queues and epics that go to "My boards". */
export function InterestStep({ t, rpc, config, prefs }: { t: Messages; rpc: Rpc; config: ConfigView; prefs: Prefs }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [suggested, setSuggested] = useState<Suggestions | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [picked, setPicked] = useState<BoardItem[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const found = useBoardSearch(rpc, config, text);
  useEffect(() => {
    let live = true;
    rpc.call("keyStatus").then(
      (status) => {
        if (!live) return;
        setHasKey(status.hasKey);
        if (status.hasKey)
          rpc.call("suggestBoards").then(
            (next) => live && setSuggested(next),
            (cause) => live && setSuggestError(errorText(t, cause)),
          );
      },
      (cause) => {
        if (!live) return;
        setHasKey(true);
        setSuggestError(errorText(t, cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  const build = useMemo(() => myBoards(config.defaultBoards, []), [config.defaultBoards]);
  const buildIds = new Set(build.map((entry) => entry.id));
  const pickedIds = new Set(picked.map((item) => sourceId(item.source)));
  const toggle = (item: BoardItem) => {
    const id = sourceId(item.source);
    if (buildIds.has(id)) return;
    setPicked((current) => (current.some((known) => sourceId(known.source) === id) ? current.filter((known) => sourceId(known.source) !== id) : [...current, item]));
  };
  const trimmed = text.trim();
  const rows: Row[] = trimmed
    ? searchRows(t, config, trimmed, found)
    : [
        ...(suggested?.queues ?? []).map((queue) => ({ group: t.fromYourTasks, item: queueItem(queue), note: t.yourTasks(queue.count) })),
        ...(suggested?.epics ?? []).map(({ issue, count }) => ({ group: t.fromYourTasks, item: issueItem(issue), note: t.yourTasks(count) })),
      ];
  // A build's queue reads by name once the suggestions name it.
  const buildItem = (entry: BoardEntry): BoardItem => {
    const source = entry.source;
    const queue = source.kind === "queue" ? suggested?.queues.find((item) => item.key === source.queue) : undefined;
    return queue ? { source, title: queue.name } : named(entry, prefs, null);
  };
  const target = picked[0] ?? (build[0] ? buildItem(build[0]) : null);
  const finish = async (keep: boolean) => {
    setBusy(true);
    try {
      await savePrefs(rpc, keep ? { boards: picked.map(savedOf), boardsReady: true } : { boardsReady: true });
      const open = (keep ? target?.source : null) ?? prefs.source ?? build[0]?.source ?? (config.can.mine ? ({ kind: "mine" } as const) : null);
      const shown = boardStore.get().board;
      if (open && (!shown || sourceId(shown.source) !== sourceId(open))) void loadBoard(rpc, open);
    } catch (cause) {
      toast.error(errorText(t, cause));
    } finally {
      setBusy(false);
    }
  };

  if (hasKey === false) {
    return (
      <div className="tb-onb">
        <div className="tb-onb-in tb-onb-one">
          <Steps t={t} keyDone={false} />
          <div>
            <h1>{t.needKeyTitle}</h1>
            <p className="tb-lead">{t.needKey}</p>
            <button className="tb-btn tb-pri" type="button" onClick={() => settingsOpenStore.set(true)}>
              {t.openSettings}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const mark = (item: BoardItem) => {
    const id = sourceId(item.source);
    if (buildIds.has(id))
      return (
        <span className="tb-tag" title={t.buildTagHint}>
          <Icons.lock />
          {t.alreadyShared}
        </span>
      );
    const on = pickedIds.has(id);
    return (
      <button
        className={`tb-addbtn${on ? " tb-on" : ""}`}
        type="button"
        title={on ? t.removeBoard : t.addBoard}
        aria-label={on ? t.removeBoard : t.addBoard}
        aria-pressed={on}
        onClick={(event) => {
          event.stopPropagation();
          toggle(item);
        }}
      >
        {on ? <Icons.check /> : <Icons.plus />}
      </button>
    );
  };

  return (
    <div className="tb-onb">
      <div className="tb-onb-in">
        <Steps t={t} keyDone />
        <div>
          <h1>{t.interestTitle}</h1>
          <p className="tb-lead">{t.interestLead}</p>
          <label className="tb-bigsearch">
            <Icons.search />
            <input value={text} placeholder={t.interestPlaceholder} aria-label={t.interestPlaceholder} onChange={(event) => setText(event.target.value)} autoFocus />
            {found.busy ? <Spinner /> : null}
          </label>
          <div className="tb-results">
            <Grouped rows={rows} render={(row) => <BoardRow key={`${row.group}:${sourceId(row.item.source)}`} t={t} item={row.item} note={row.note} onOpen={() => toggle(row.item)} tail={mark(row.item)} />} />
            {!trimmed && !suggested && !suggestError ? (
              <div className="tb-mh tb-onb-wait">
                <Spinner /> {t.lookingThrough}
              </div>
            ) : null}
            {!trimmed && suggestError ? <div className="tb-mh">{suggestError}</div> : null}
            {!trimmed && suggested && rows.length === 0 ? <div className="tb-mh">{t.noSuggestions}</div> : null}
            {trimmed.length >= 2 && !found.busy && found.text === trimmed && rows.length === 0 ? <div className="tb-mh">{t.nothingFoundBoards}</div> : null}
          </div>
        </div>
        <aside className="tb-mine-box">
          <h2>{t.myBoards}</h2>
          <p className="tb-sub">
            {t.boardsCount(build.length + picked.length)}. {t.mineSub}
          </p>
          {build.map((entry) => (
            <BoardRow key={entry.id} t={t} item={buildItem(entry)} entry={entry} />
          ))}
          {picked.map((item) => (
            <BoardRow
              key={sourceId(item.source)}
              t={t}
              item={item}
              tail={
                <button className="tb-br-act" type="button" title={t.removeBoard} aria-label={t.removeBoard} onClick={() => toggle(item)}>
                  <Icons.x />
                </button>
              }
            />
          ))}
          <div className="tb-mine-foot">
            <button className="tb-btn tb-pri" type="button" disabled={busy} onClick={() => void finish(true)}>
              {t.finish}
            </button>
            <button className="tb-btn tb-ghost" type="button" disabled={busy} onClick={() => void finish(false)}>
              {t.skip}
            </button>
            {busy ? <Spinner /> : null}
          </div>
          {target ? <p className="tb-sub tb-mine-next">{t.willOpen(boardLabel(t, target).name)}</p> : null}
        </aside>
      </div>
    </div>
  );
}
