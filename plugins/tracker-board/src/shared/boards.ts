// "My boards": the boards a person switches between, the build's shared ones among
// them. A build's board can be hidden but not removed; the person adds their own and
// orders all of them. Pure functions: the panel calls them and saves the result.
import { LIMITS } from "./limits";
import type { Kind } from "./model";
import { sourceFromText, sourceId, type SavedBoard, type Source } from "./prefs";

export interface BoardEntry extends SavedBoard {
  id: string;
  /** One of the build's shared boards. */
  build: boolean;
}

/** The build's boards from its setting: keys, queues or links, one per line or comma. */
export function parseDefaultBoards(text: string): Source[] {
  const out: Source[] = [];
  for (const part of text.split(/[\n,]+/)) {
    const trimmed = part.trim();
    const source = trimmed === "mine" ? ({ kind: "mine" } as const) : sourceFromText(trimmed, false);
    if (source && !out.some((known) => sourceId(known) === sourceId(source))) out.push(source);
  }
  return out.slice(0, LIMITS.boards);
}

/** The saved list, with the build's boards nobody has touched yet on top. */
export function myBoards(defaults: readonly Source[], saved: readonly SavedBoard[]): BoardEntry[] {
  const buildIds = new Set(defaults.map(sourceId));
  const savedIds = new Set(saved.map((board) => sourceId(board.source)));
  const untouched = defaults.filter((source) => !savedIds.has(sourceId(source))).map((source) => ({ source, title: "", hidden: false }));
  return [...untouched, ...saved].map((board) => {
    const id = sourceId(board.source);
    return { ...board, id, build: buildIds.has(id), hidden: buildIds.has(id) && board.hidden };
  });
}

const toSaved = (entries: readonly BoardEntry[]): SavedBoard[] => entries.map(({ source, title, kind, hidden }) => ({ source, title, ...(kind ? { kind } : {}), hidden })).slice(0, LIMITS.boards);

/** Adds a board at the end, or takes the person's own board away. A build's board stays. */
export function togglePinned(entries: readonly BoardEntry[], source: Source, title: string, kind?: Kind): SavedBoard[] {
  const id = sourceId(source);
  const found = entries.find((entry) => entry.id === id);
  if (found?.build) return toSaved(entries.map((entry) => (entry.id === id ? { ...entry, hidden: false } : entry)));
  if (found) return toSaved(entries.filter((entry) => entry.id !== id));
  return toSaved([...entries, { source, title, ...(kind ? { kind } : {}), hidden: false, id, build: false }]);
}

export function setHidden(entries: readonly BoardEntry[], id: string, hidden: boolean): SavedBoard[] {
  return toSaved(entries.map((entry) => (entry.id === id && entry.build ? { ...entry, hidden } : entry)));
}

/** Moves a board before another one, or to the end when `before` is null. */
export function moveBoard(entries: readonly BoardEntry[], id: string, before: string | null): SavedBoard[] {
  const moving = entries.find((entry) => entry.id === id);
  if (!moving || id === before) return toSaved(entries);
  const rest = entries.filter((entry) => entry.id !== id);
  const at = before === null ? rest.length : rest.findIndex((entry) => entry.id === before);
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  return toSaved(rest);
}

/** A loaded board's title goes into its entry, so the list reads by name. */
export function withTitle(saved: readonly SavedBoard[], source: Source, title: string, kind?: Kind): SavedBoard[] {
  const id = sourceId(source);
  return saved.map((board) => (sourceId(board.source) === id && (board.title !== title || (kind && board.kind !== kind)) ? { ...board, title, ...(kind ? { kind } : {}) } : board));
}

/** Puts a removed board back where it was: before the board that followed it. */
export function restoreBoard(entries: readonly BoardEntry[], board: SavedBoard, before: string | null): SavedBoard[] {
  const id = sourceId(board.source);
  // Added back by hand in the meantime: leave it where it is now.
  if (entries.some((entry) => entry.id === id)) return toSaved(entries);
  const added = togglePinned(entries, board.source, board.title, board.kind);
  return moveBoard(
    added.map((saved) => ({ ...saved, id: sourceId(saved.source), build: false })),
    id,
    before,
  );
}

export function isPinned(entries: readonly BoardEntry[], source: Source): BoardEntry | null {
  const id = sourceId(source);
  return entries.find((entry) => entry.id === id) ?? null;
}

/**
 * Queues a search found, best first. A tracker lists matches in its own order, often by
 * key, and the queue a person looks for can sit past the first page: the person's own
 * queues (their boards, recent ones, the build's) go first, then an exact key, a key or a
 * name that starts with the text, a word of the name that does, and the rest.
 */
export function rankQueues<Q extends { key: string; name: string }>(queues: readonly Q[], text: string, mine: ReadonlySet<string>): Q[] {
  const needle = text.trim().toLowerCase();
  const score = (queue: Q) => {
    const key = queue.key.toLowerCase();
    const name = queue.name.toLowerCase();
    if (key === needle) return 0;
    const own = mine.has(queue.key) ? 0 : 10;
    if (key.startsWith(needle)) return own + 1;
    if (name.startsWith(needle)) return own + 2;
    if (name.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return own + 3;
    if (key.includes(needle)) return own + 4;
    if (name.includes(needle)) return own + 5;
    return own + 6;
  };
  return queues
    .map((queue, index) => ({ queue, index, score: score(queue) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.queue);
}
