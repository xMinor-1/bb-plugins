// One copy of the figures for every surface in this tab — the footer rings,
// the footer card and the page — so opening the card does not ask the server
// again for what the rings already have. Plain fetch: the rings and the card
// live outside the page's React tree and its RPC hooks.
import { useSyncExternalStore } from "react";
import type { LimitsSnapshot, TokensSnapshot } from "../src/shared/types";

export interface StoreState {
  limits: LimitsSnapshot | null;
  tokens: TokensSnapshot | null;
  error: string | null;
  refreshing: boolean;
}

let state: StoreState = { limits: null, tokens: null, error: null, refreshing: false };
const listeners = new Set<() => void>();
let pluginId: string | null = null;
let generation = 0;
let inflight = 0;

function set(next: Partial<StoreState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function setPluginId(id: string): void {
  pluginId = id;
}

async function call<T>(method: string, input: unknown, signal?: AbortSignal): Promise<T> {
  if (!pluginId) throw new Error("The plugin is not ready yet.");
  const timeout = AbortSignal.timeout(60_000);
  const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; error?: { message?: string } | string } | null;
  if (!response.ok || !body?.ok) {
    const error = body?.error;
    throw new Error(typeof error === "string" ? error : (error?.message ?? `HTTP ${response.status}`));
  }
  return body.result as T;
}

/**
 * Fetches limits and tokens no older than `maxAgeMs`. Answers that come back
 * after a newer request was sent are dropped, so a slow first load cannot
 * overwrite a fresh refresh.
 */
export async function refresh(options: { maxAgeMs: number; force?: boolean; signal?: AbortSignal }): Promise<void> {
  const mine = ++generation;
  inflight += 1;
  set({ refreshing: true });
  const input = { maxAgeMs: options.maxAgeMs, force: options.force ?? false };
  try {
    const [limits, tokens] = await Promise.allSettled([
      call<LimitsSnapshot>("limits", input, options.signal),
      call<TokensSnapshot>("tokens", input, options.signal),
    ]);
    if (mine !== generation || options.signal?.aborted) return;
    const failed = [limits, tokens].find((r): r is PromiseRejectedResult => r.status === "rejected");
    set({
      limits: limits.status === "fulfilled" ? limits.value : state.limits,
      tokens: tokens.status === "fulfilled" ? tokens.value : state.tokens,
      error: failed ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : null,
    });
  } finally {
    inflight -= 1;
    if (inflight === 0) set({ refreshing: false });
  }
}

export function useStore(): StoreState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function storeNow(): StoreState {
  return state;
}

/** Claude Code's five-hour and weekly use on the server's machine, for the rings. */
export function claudeRings(limits: LimitsSnapshot | null): { session: number; week: number; extra: number } | null {
  if (!limits) return null;
  const primary = limits.machines.find((m) => m.primary)?.id ?? null;
  const claude =
    limits.accounts.find((a) => a.providerId === "claude-code" && a.hostId === primary && a.status === "ok") ??
    limits.accounts.find((a) => a.providerId === "claude-code" && a.status === "ok");
  if (!claude) return null;
  const pick = (kind: string) => claude.windows.find((w) => w.kind === kind && w.model === null)?.usedPercent ?? null;
  const session = pick("five-hour");
  const week = pick("weekly");
  if (session === null && week === null) return null;
  const extra = Math.max(0, ...claude.windows.filter((w) => w.model !== null).map((w) => w.usedPercent));
  return { session: session ?? 0, week: week ?? 0, extra };
}
