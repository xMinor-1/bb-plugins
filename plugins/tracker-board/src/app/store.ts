// State shared by the board page and the task tab in bb's side panel. They render
// in different React trees, so the state lives in this module, outside both.
import type { useRpc } from "@get-bb/plugin-sdk/app";
import { useSyncExternalStore } from "react";
import type { ChangeInput } from "../shared/changes";
import type { Issue } from "../shared/model";
import type { Prefs, Source } from "../shared/prefs";
import type { BoardView, ConfigView, rpcContract } from "../server/rpc-contract";
import type { Messages } from "./messages";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export interface Store<T> {
  get(): T;
  set(next: T | ((current: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export const configStore = createStore<ConfigView | null>(null);
export const prefsStore = createStore<Prefs | null>(null);
export const boardStore = createStore<{ board: BoardView | null; loading: boolean; error: unknown }>({ board: null, loading: false, error: null });
export const selectionStore = createStore<ReadonlySet<string>>(new Set());
export const flashStore = createStore<ReadonlySet<string>>(new Set());
/** The key shown in the side panel tab. */
export const openKeyStore = createStore<string | null>(null);
export const chatOpenStore = createStore<boolean>(false);
export const settingsOpenStore = createStore<boolean>(false);
/** Task pills waiting for the chat's composer to appear. */
export const pendingPillsStore = createStore<string[]>([]);

let boardRequest = 0;

/** Loads a board. A late answer for an older request is dropped. */
export async function loadBoard(rpc: Rpc, source: Source): Promise<void> {
  const request = ++boardRequest;
  boardStore.set((current) => ({ ...current, loading: true, error: null }));
  try {
    const board = await rpc.call("board", { source });
    if (request !== boardRequest) return;
    boardStore.set({ board, loading: false, error: null });
    prefsStore.set((prefs) => (prefs ? { ...prefs, source } : prefs));
    const keys = new Set(board.issues.map((issue) => issue.key));
    selectionStore.set((current) => new Set([...current].filter((key) => keys.has(key))));
  } catch (error) {
    if (request !== boardRequest) return;
    boardStore.set((current) => ({ ...current, loading: false, error }));
  }
}

export async function reloadBoard(rpc: Rpc): Promise<void> {
  const source = boardStore.get().board?.source ?? prefsStore.get()?.source;
  if (source) await loadBoard(rpc, source);
}

export function flash(keys: readonly string[]): void {
  flashStore.set(new Set(keys));
  setTimeout(() => flashStore.set((current) => (current.size === 0 ? current : new Set())), 1600);
}

/** Replaces one issue in the board with a fresh copy. */
export function patchIssue(issue: Issue): void {
  boardStore.set((current) => {
    if (!current.board) return current;
    return { ...current, board: { ...current.board, issues: current.board.issues.map((item) => (item.key === issue.key ? issue : item)) } };
  });
}

export function toggleSelected(key: string): void {
  selectionStore.set((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}

export async function savePrefs(rpc: Rpc, partial: Partial<Prefs>): Promise<void> {
  prefsStore.set((current) => (current ? { ...current, ...partial } : current));
  prefsStore.set(await rpc.call("setPrefs", partial));
}

/** The code of a server error: `tracker-board:<code>…`. */
export function errorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const start = message.indexOf("tracker-board:");
  if (start < 0) return null;
  const rest = message.slice(start + "tracker-board:".length);
  const end = rest.search(/[\s:]/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Codes where the tracker's own words help: what exactly it refused. */
const SHOW_DETAIL = new Set(["badRequest", "serverError", "forbidden", "conflict"]);

/** The JSON a server error carries after its code: the tracker's words and the machine. */
function errorExtra(message: string): { detail: string | null; machine: string | null } {
  const start = message.indexOf("tracker-board:");
  const brace = start < 0 ? -1 : message.indexOf("{", start);
  if (brace < 0) return { detail: null, machine: null };
  try {
    const parsed = JSON.parse(message.slice(brace)) as { detail?: unknown; machine?: unknown };
    return { detail: typeof parsed.detail === "string" ? parsed.detail : null, machine: typeof parsed.machine === "string" ? parsed.machine : null };
  } catch {
    return { detail: null, machine: null };
  }
}

export function errorText(t: Messages, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  if (code) {
    const known = (t as unknown as Record<string, unknown>)[`error_${code}`];
    if (typeof known === "string") {
      const { detail, machine } = errorExtra(message);
      return [known, detail && SHOW_DETAIL.has(code) ? t.trackerSaid(detail) : null, machine ? t.fromMachine(machine) : null].filter(Boolean).join(" ");
    }
  }
  return message.replace(/^.*?tracker-board:\S*\s?/, "") || String(error);
}

export function failureText(t: Messages, code: string | null, detail: string | null): string {
  const table = t as unknown as Record<string, unknown>;
  const known = code ? table[`error_${code}`] ?? table[code] : null;
  const base = typeof known === "string" ? known : code ?? t.failed;
  return detail ? `${base} ${detail}` : base;
}

/** Applies changes the person made in the panel; returns what failed. */
export async function applyNow(rpc: Rpc, changes: ChangeInput[]): Promise<{ ok: string[]; failed: { key: string; why: string | null; code: string | null }[] }> {
  const planned = await rpc.call("preview", { changes: changes as never });
  const approve = planned.filter((item) => item.ok).map((item) => item.id);
  const { results } = await rpc.call("apply", { changes: changes as never, approve });
  const byId = new Map(planned.map((item) => [item.id, item]));
  const ok: string[] = [];
  const failed: { key: string; why: string | null; code: string | null }[] = [];
  for (const result of results) {
    const key = result.key ?? byId.get(result.id)?.key ?? "";
    if (result.ok) ok.push(key);
    else failed.push({ key, why: result.detail, code: result.code });
  }
  for (const item of planned) if (!item.ok && item.skip !== "same") failed.push({ key: item.key ?? item.title, why: null, code: `skip_${item.skip}` });
  return { ok, failed };
}
