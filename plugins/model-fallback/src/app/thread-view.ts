// One shared copy of each thread's fallback state for the page. The segment
// above the message box and every message label read it, so a thread costs one
// RPC per change, not one per mounted component.
import { useCallback, useEffect, useReducer } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server";
import { THREAD_CHANGED, type ThreadView } from "../shared/state";

interface Entry {
  view: ThreadView | null;
  /** Server clock minus page clock at the last load, for the countdown. */
  offset: number;
  loading: boolean;
  /** A change arrived while loading: load again when this load ends. */
  stale: boolean;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

function entryFor(threadId: string): Entry {
  let entry = entries.get(threadId);
  if (!entry) {
    entry = { view: null, offset: 0, loading: false, stale: false, listeners: new Set() };
    entries.set(threadId, entry);
  }
  return entry;
}

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

function load(rpc: Rpc, threadId: string): void {
  const entry = entryFor(threadId);
  if (entry.loading) {
    entry.stale = true;
    return;
  }
  entry.loading = true;
  entry.stale = false;
  rpc
    .call("thread_view", { threadId })
    .then(
      (view) => {
        entry.view = view;
        entry.offset = view.now - Date.now();
        for (const listener of entry.listeners) listener();
      },
      () => {},
    )
    .finally(() => {
      entry.loading = false;
      if (entry.stale) load(rpc, threadId);
    });
}

export function useThreadView(threadId: string): { view: ThreadView | null; offset: number; reload: () => void } {
  const rpc = useRpc<RpcContract>();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const entry = entryFor(threadId);
  const reload = useCallback(() => load(rpc, threadId), [rpc, threadId]);
  useEffect(() => {
    const current = entryFor(threadId);
    current.listeners.add(rerender);
    if (current.view === null) load(rpc, threadId);
    return () => {
      current.listeners.delete(rerender);
    };
  }, [rpc, threadId]);
  useRealtime(THREAD_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) reload();
  });
  return { view: entry.view, offset: entry.offset, reload };
}
