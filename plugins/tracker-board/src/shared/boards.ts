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
