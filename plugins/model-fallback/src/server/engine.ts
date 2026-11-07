// The fallback engine: finds failed and hung turns, counts down, stops the
// hung turn and continues the thread on the next model of its ladder.
//
// It talks to bb through the small `EngineSdk` port so tests can drive it
// without a server; server.ts adapts the real SDK to it.

import { inLadder, type Ladder } from "../shared/ladder";
import type { Policy } from "../shared/policy";
import type { FallbackReason } from "../shared/reason";
import {
  emptyState,
  MAX_LOG,
  MAX_SENT,
  type LogEntry,
  type ModelRef,
  type NotSwitchedWhy,
  type PendingSwitch,
  type ThreadState,
  type ThreadView,
} from "../shared/state";
import { classifyFailure } from "./classify";
import { continueMessage, type MessageLanguage } from "./message";
import { HangTracker, type HangLimits, type TrackerEvent } from "./tracker";

export interface EventRow extends TrackerEvent {
  data?: unknown;
}

export interface CatalogModel {
  model: string;
  displayName: string;
}

export type InputBlock = Record<string, unknown> & { type: string };

export interface ThreadInfo {
  id: string;
  providerId: string;
  status: string;
  environmentId: string | null;
  archived: boolean;
}

/** The parts of the bb SDK the engine uses. */
export interface EngineSdk {
  getThread(threadId: string): Promise<ThreadInfo | null>;
  listRunning(): Promise<Array<{ id: string; hostId: string | null }>>;
  /**
   * One page of the thread's events: ascending after `afterSeq`, or descending
   * before `beforeSeq` (from the newest when it is null). bb caps `limit` at 100.
   */
  listEvents(
    threadId: string,
    query: { order: "asc"; afterSeq: number } | { order: "desc"; beforeSeq: number | null },
    limit: number,
  ): Promise<EventRow[]>;
  stop(threadId: string): Promise<void>;
  setModel(threadId: string, model: string): Promise<void>;
  send(threadId: string, model: string, input: InputBlock[]): Promise<void>;
  /** Models the thread's machine offers for its provider; throws when unknown. */
  catalog(thread: ThreadInfo): Promise<CatalogModel[]>;
  /** Whether the machine the thread runs on is connected right now. */
  hostConnected(thread: ThreadInfo, hostId: string | null): Promise<boolean>;
  /** Whether another plugin (provider-retry) already queued a retry of the turn. */
  hasQueuedRetry(threadId: string): Promise<boolean>;
}

export interface EngineConfig {
  policy: Policy;
  ladders: readonly Ladder[];
  graceMs: number;
  limits: HangLimits;
  language: MessageLanguage;
}

export interface EngineStore {
  get(threadId: string): Promise<ThreadState | undefined>;
  set(threadId: string, state: ThreadState): Promise<void>;
  threadIds(): Promise<string[]>;
}

export interface FailedTurn {
  threadId: string;
  requestId: string;
  inputAccepted: boolean;
  errorInfo: { category: string; httpStatusCode: number | null } | null;
}

interface Tracked {
  tracker: HangTracker;
  /** createdAt of the turn's `client/turn/requested`, for timeline labels. */
  requestedAt: number;
}

/** bb answers at most 100 events per request. */
export const EVENT_PAGE = 100;
const MAX_PAGES = 20;
const STOP_WAIT_MS = 45_000;
const STOP_POLL_MS = 1_000;
const ERROR_EVENT_TYPES = new Set(["provider/error", "provider/warning", "system/error", "turn/completed"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export class Engine {
  private readonly tracked = new Map<string, Tracked>();
  private readonly providers = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Threads with a pending switch; filled from the store on start. */
  private readonly withPending = new Set<string>();
  /**
   * Threads whose new events matter even when they are not running: a switch
   * is pending, the thread is on its fallback or shows a notice, or the plugin
   * just sent a turn it has not seen requested yet. A short turn can start and
   * end between two passes, so these follow bb's thread events instead.
   */
  private readonly watched = new Set<string>();
  private readonly awaitingOwn = new Map<string, number>();
  private ticking = false;

  constructor(
    private readonly sdk: EngineSdk,
    private readonly store: EngineStore,
    private config: EngineConfig,
    private readonly hooks: {
      pluginId: string;
      now: () => number;
      publish: (threadId: string) => void;
      log: (message: string) => void;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** Picks up switches that were pending when the plugin stopped. */
  async init(): Promise<void> {
    for (const threadId of await this.store.threadIds()) {
      const state = await this.store.get(threadId);
      if (state && (state.pending || state.active || state.notice)) this.watched.add(threadId);
      if (state?.pending) {
        this.withPending.add(threadId);
        if (state.pending.dueAt !== null) this.schedule(threadId, Math.max(1, state.pending.dueAt - this.now()));
      }
    }
  }

  configure(config: EngineConfig): void {
    this.config = config;
  }

  private now(): number {
    return this.hooks.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.hooks.sleep ? this.hooks.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Runs `work` after every earlier call for the same thread has finished. */
  private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.locks.set(threadId, settled);
    void settled.then(() => {
      if (this.locks.get(threadId) === settled) this.locks.delete(threadId);
    });
    return next;
  }

  private async load(threadId: string): Promise<ThreadState> {
    return (await this.store.get(threadId)) ?? emptyState();
  }

  private async save(threadId: string, state: ThreadState): Promise<void> {
    state.log = state.log.slice(-MAX_LOG);
    state.sent = state.sent.slice(-MAX_SENT);
    state.ownRequests = state.ownRequests.slice(-MAX_SENT);
    await this.store.set(threadId, state);
    if (state.pending) this.withPending.add(threadId);
    else this.withPending.delete(threadId);
    if (state.pending || state.active || state.notice || this.awaitingOwn.has(threadId)) this.watched.add(threadId);
    else this.watched.delete(threadId);
    this.hooks.publish(threadId);
  }

  private covers(provider: string): boolean {
    return this.config.ladders.some((ladder) => ladder.provider === provider);
  }

  // ---------- events ----------

  /** Reads the thread's new events into its tracker and does the bookkeeping they imply. */
  private async refresh(threadId: string): Promise<Tracked> {
    let entry = this.tracked.get(threadId);
    let rows: EventRow[];
    if (!entry) {
      entry = { tracker: new HangTracker(this.now()), requestedAt: 0 };
      this.tracked.set(threadId, entry);
      rows = await this.latestTurn(threadId);
    } else {
      rows = [];
      let after = entry.tracker.seq;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const batch = await this.sdk.listEvents(threadId, { order: "asc", afterSeq: after }, EVENT_PAGE);
        rows.push(...batch);
        if (batch.length < EVENT_PAGE) break;
        after = Math.max(after, ...batch.map((row) => row.seq));
      }
    }
    const requests: EventRow[] = [];
    for (const row of rows) {
      entry.tracker.feed(row);
      if (row.type === "client/turn/requested") {
        entry.requestedAt = row.createdAt;
        requests.push(row);
      }
    }
    if (requests.length > 0) await this.noteRequests(threadId, requests);
    return entry;
  }

  /** The events of the thread's latest turn, oldest first, from its `client/turn/requested` on. */
  private async latestTurn(threadId: string): Promise<EventRow[]> {
    const collected: EventRow[] = [];
    let before: number | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await this.sdk.listEvents(threadId, { order: "desc", beforeSeq: before }, EVENT_PAGE);
      collected.push(...batch);
      if (batch.some((row) => row.type === "client/turn/requested") || batch.length < EVENT_PAGE) break;
      before = Math.min(...batch.map((row) => row.seq));
    }
    const ascending = collected.sort((a, b) => a.seq - b.seq);
    let start = 0;
    ascending.forEach((row, index) => {
      if (row.type === "client/turn/requested") start = index;
    });
    return ascending.slice(start);
  }

  /** A new turn was requested: notice who chose its model and forget stale state. */
  private async noteRequests(threadId: string, rows: EventRow[]): Promise<void> {
    await this.serial(threadId, async () => {
      const state = await this.load(threadId);
      let changed = false;
      for (const row of rows) {
        const data = record(row.data);
        const requestId = str(data.requestId);
        const model = str(record(data.execution).model);
        const ours = str(data.originPluginId) === this.hooks.pluginId;
        if (ours) {
          this.awaitingOwn.delete(threadId);
          if (requestId !== null && !state.ownRequests.includes(requestId)) {
            state.ownRequests.push(requestId);
            const last = state.active;
            if (last) state.sent.push({ at: row.createdAt, from: lastFrom(state) ?? last.original, to: last.current });
            changed = true;
          }
          continue;
        }
        if (requestId !== null && state.ownRequests.includes(requestId)) continue;
        if (state.notice && state.notice.requestId !== requestId) {
          state.notice = null;
          changed = true;
        }
        if (state.pending && state.pending.requestId !== requestId) {
          state.pending = null;
          this.clearTimer(threadId);
          changed = true;
        }
        // The person sent a turn on another model: the fallback is over.
        if (state.active && model !== null && model !== state.active.current.id) {
          state.active = null;
          changed = true;
        }
      }
      if (changed) await this.save(threadId, state);
    });
  }

  /** bb reported new events on a thread (debounced): keep the bookkeeping current for watched ones. */
  async onThreadEvents(threadId: string): Promise<void> {
    if (!this.watched.has(threadId)) return;
    await this.refresh(threadId);
  }

  // ---------- failures ----------

  async onTurnFailed(event: FailedTurn): Promise<void> {
    const thread = await this.sdk.getThread(event.threadId);
    if (!thread || thread.archived || !this.covers(thread.providerId)) return;
    this.providers.set(thread.id, thread.providerId);
    const entry = await this.refresh(thread.id);
    const tracker = entry.tracker;
    if (tracker.requestId !== event.requestId || tracker.model === null) return;
    const model = tracker.model;
    if (!inLadder(this.config.ladders, thread.providerId, model)) return;
    // provider-retry already re-runs this turn on the same model: do not race it.
    if (await this.sdk.hasQueuedRetry(thread.id)) return;

    const text = await this.errorText(thread.id, event.requestId);
    const verdict = classifyFailure({
      category: event.errorInfo?.category ?? null,
      httpStatusCode: event.errorInfo?.httpStatusCode ?? null,
      text,
    });
    if (!verdict.switch) {
      await this.notSwitched(thread, event.requestId, model, verdict.why);
      return;
    }
    await this.propose(thread, {
      requestId: event.requestId,
      model,
      reason: verdict.reason,
      trigger: "failure",
      resend: !event.inputAccepted,
    });
  }

  /** The provider's own words about the failed turn, newest last. */
  private async errorText(threadId: string, requestId: string): Promise<string> {
    const rows = await this.latestTurn(threadId);
    const start = rows.findIndex(
      (row) => row.type === "client/turn/requested" && str(record(row.data).requestId) === requestId,
    );
    if (start < 0) return "";
    const parts: string[] = [];
    for (const row of rows) {
      if (!ERROR_EVENT_TYPES.has(row.type)) continue;
      const data = record(row.data);
      for (const value of [data.message, data.detail, data.summary, record(data.error).message]) {
        const text = str(value);
        if (text !== null) parts.push(text);
      }
    }
    return parts.join("\n").slice(-4000);
  }

  private async notSwitched(thread: ThreadInfo, requestId: string, model: string, why: NotSwitchedWhy): Promise<void> {
    const ref = await this.ref(thread, model);
    await this.serial(thread.id, async () => {
      const state = await this.load(thread.id);
      if (state.notice?.requestId === requestId) return;
      // An error nobody can explain stays in the log only: a notice would be noise.
      if (why !== "unknown") state.notice = { kind: "not-switched", requestId, model: ref, why, at: this.now() };
      state.log.push({ kind: "not-switched", at: this.now(), model: ref, why });
      await this.save(thread.id, state);
    });
    this.hooks.log(`${thread.id}: not switching from ${model}: ${why}`);
  }

  // ---------- hangs ----------

  /** One pass over running threads: hangs, due switches, stale state. Runs every few seconds. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const running = await this.sdk.listRunning();
      const runningIds = new Set(running.map((item) => item.id));
      for (const item of running) {
        try {
          await this.watch(item.id, item.hostId);
        } catch (error) {
          this.hooks.log(`${item.id}: watch failed: ${String(error)}`);
        }
      }
      for (const [threadId, since] of [...this.awaitingOwn]) {
        if (runningIds.has(threadId)) continue;
        if (this.now() - since > 10 * 60_000) {
          this.awaitingOwn.delete(threadId);
          continue;
        }
        try {
          await this.refresh(threadId);
        } catch (error) {
          this.hooks.log(`${threadId}: refresh failed: ${String(error)}`);
        }
      }
      for (const threadId of [...this.withPending]) {
        try {
          await this.sweep(threadId, runningIds.has(threadId));
          await this.runIfDue(threadId);
        } catch (error) {
          this.hooks.log(`${threadId}: switch failed: ${String(error)}`);
        }
      }
      for (const threadId of [...this.tracked.keys()]) {
        if (!runningIds.has(threadId) && !this.timers.has(threadId)) this.tracked.delete(threadId);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** A hang switch makes no sense once the turn is over: drop it. */
  private async sweep(threadId: string, running: boolean): Promise<void> {
    if (running) return;
    await this.serial(threadId, async () => {
      const state = await this.load(threadId);
      const pending = state.pending;
      if (!pending || pending.trigger !== "hang") return;
      this.clearTimer(threadId);
      state.pending = null;
      if (pending.dueAt !== null) state.log.push({ kind: "recovered", at: this.now(), model: pending.from });
      await this.save(threadId, state);
    });
  }

  private async providerOf(threadId: string): Promise<ThreadInfo | null> {
    const thread = await this.sdk.getThread(threadId);
    if (thread) this.providers.set(threadId, thread.providerId);
    return thread;
  }

  private async watch(threadId: string, hostId: string | null): Promise<void> {
    const known = this.providers.get(threadId);
    if (known !== undefined && !this.covers(known)) return;
    const thread = await this.providerOf(threadId);
    if (!thread || thread.archived || !this.covers(thread.providerId)) return;
    const { tracker } = await this.refresh(threadId);
    const verdict = tracker.verdict(this.now(), this.config.limits);
    if (verdict === null || tracker.requestId === null || tracker.model === null) return;
    if (!inLadder(this.config.ladders, thread.providerId, tracker.model)) return;
    const state = await this.load(threadId);
    // Already decided about this turn, or the person chose to keep waiting.
    if (state.pending?.requestId === tracker.requestId) return;
    if (state.notice?.requestId === tracker.requestId) return;
    // Events stop coming when the machine drops off, not only when the model hangs.
    if (!(await this.sdk.hostConnected(thread, hostId))) return;
    await this.propose(thread, {
      requestId: tracker.requestId,
      model: tracker.model,
      reason: verdict,
      trigger: "hang",
      resend: false,
    });
  }

  // ---------- switching ----------

  private async ref(thread: ThreadInfo, model: string, catalog?: CatalogModel[]): Promise<ModelRef> {
    let models = catalog;
    if (!models) {
      try {
        models = await this.sdk.catalog(thread);
      } catch {
        models = [];
      }
    }
    const found = models.find((item) => item.model === model);
    return { id: model, name: displayName(found?.displayName ?? model) };
  }

  /** The next model of the ladder that is allowed and offered on the thread's machine. */
  private nextOffered(provider: string, model: string, catalog: CatalogModel[]): string | null {
    const ladder = this.config.ladders.find((item) => item.provider === provider && item.models.includes(model));
    if (!ladder) return null;
    const offered = new Set(catalog.map((item) => item.model));
    for (const candidate of ladder.models.slice(ladder.models.indexOf(model) + 1)) {
      if (this.config.policy.allows(provider, candidate) && offered.has(candidate)) return candidate;
    }
    return null;
  }

  private async propose(
    thread: ThreadInfo,
    found: { requestId: string; model: string; reason: FallbackReason; trigger: "failure" | "hang"; resend: boolean },
  ): Promise<void> {
    let catalog: CatalogModel[];
    try {
      catalog = await this.sdk.catalog(thread);
    } catch (error) {
      // Without the machine's list the plugin cannot prove a model is allowed there.
      this.hooks.log(`${thread.id}: model list unavailable, not switching: ${String(error)}`);
      return;
    }
    const from = await this.ref(thread, found.model, catalog);
    const nextId = this.nextOffered(thread.providerId, found.model, catalog);
    const runNow = await this.serial(thread.id, async () => {
      const state = await this.load(thread.id);
      if (state.pending?.requestId === found.requestId) return false;
      if (nextId === null) {
        if (state.notice?.requestId === found.requestId) return false;
        state.notice = { kind: "no-fallback", requestId: found.requestId, model: from, reason: found.reason, at: this.now() };
        state.log.push({ kind: "no-fallback", at: this.now(), model: from, reason: found.reason });
        await this.save(thread.id, state);
        this.hooks.log(`${thread.id}: ${found.model} failed and has no fallback left`);
        return false;
      }
      const to = await this.ref(thread, nextId, catalog);
      const pending: PendingSwitch = {
        requestId: found.requestId,
        provider: thread.providerId,
        from,
        to,
        reason: found.reason,
        trigger: found.trigger,
        resend: found.resend,
        createdAt: this.now(),
        dueAt: this.now() + this.config.graceMs,
      };
      state.pending = pending;
      state.notice = null;
      await this.save(thread.id, state);
      this.hooks.log(`${thread.id}: ${found.model} -> ${nextId} in ${this.config.graceMs / 1000} s (${found.reason.kind})`);
      return this.config.graceMs <= 0;
    });
    if (runNow) {
      await this.run(thread.id, false);
    } else {
      this.schedule(thread.id, this.config.graceMs);
    }
  }

  private schedule(threadId: string, delayMs: number): void {
    this.clearTimer(threadId);
    if (delayMs <= 0) return;
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      void this.runIfDue(threadId).catch((error) => this.hooks.log(`${threadId}: switch failed: ${String(error)}`));
    }, delayMs + 50);
    timer.unref?.();
    this.timers.set(threadId, timer);
  }

  private clearTimer(threadId: string): void {
    const timer = this.timers.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(threadId);
  }

  private async runIfDue(threadId: string): Promise<void> {
    const state = await this.store.get(threadId);
    const due = state?.pending?.dueAt;
    if (due === undefined || due === null || due > this.now()) return;
    await this.run(threadId, false);
  }

  /** Carries out the pending switch: `manual` when the person pressed Switch now. */
  async run(threadId: string, manual: boolean): Promise<void> {
    await this.serial(threadId, async () => {
      const state = await this.load(threadId);
      const pending = state.pending;
      if (!pending) return;
      if (!manual && (pending.dueAt === null || pending.dueAt > this.now())) return;
      this.clearTimer(threadId);
      const thread = await this.sdk.getThread(threadId);
      const drop = async (entry: LogEntry | null) => {
        state.pending = null;
        if (entry) state.log.push(entry);
        await this.save(threadId, state);
      };
      if (!thread || thread.archived) return drop(null);
      const { tracker } = await this.refresh(threadId);
      if (tracker.requestId !== pending.requestId) return drop(null);

      if (pending.trigger === "hang") {
        // The model may have come back during the countdown.
        if (tracker.done || tracker.verdict(this.now(), this.config.limits) === null) {
          if (!manual) return drop({ kind: "recovered", at: this.now(), model: pending.from });
        }
        if (!tracker.done) {
          await this.sdk.stop(threadId);
          await this.waitStopped(threadId);
        }
      } else if (thread.status === "active" || thread.status === "starting") {
        // Someone already continued the thread.
        return drop(null);
      }

      try {
        await this.sdk.setModel(threadId, pending.to.id);
        const input = await this.continuationInput(threadId, pending);
        await this.sdk.send(threadId, pending.to.id, input);
        this.awaitingOwn.set(threadId, this.now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.hooks.log(`${threadId}: switch to ${pending.to.id} failed: ${message}`);
        return drop({ kind: "failed", at: this.now(), from: pending.from, to: pending.to, error: message.slice(0, 300) });
      }
      state.active = {
        original: state.active?.original ?? pending.from,
        current: pending.to,
        reason: pending.reason,
        at: this.now(),
      };
      state.notice = null;
      this.hooks.log(`${threadId}: switched ${pending.from.id} -> ${pending.to.id}`);
      return drop({ kind: "switched", at: this.now(), from: pending.from, to: pending.to, reason: pending.reason });
    });
  }

  private async waitStopped(threadId: string): Promise<void> {
    const deadline = this.now() + STOP_WAIT_MS;
    while (this.now() < deadline) {
      const thread = await this.sdk.getThread(threadId);
      if (!thread || !["active", "stopping", "starting"].includes(thread.status)) return;
      await this.sleep(STOP_POLL_MS);
    }
  }

  private async continuationInput(threadId: string, pending: PendingSwitch): Promise<InputBlock[]> {
    const text = continueMessage({
      language: this.config.language,
      fromName: pending.from.name,
      toName: pending.to.name,
      reason: pending.reason,
      resending: pending.resend,
    });
    const note: InputBlock = { type: "text", text, mentions: [] };
    if (!pending.resend) return [note];
    const original = await this.originalInput(threadId, pending.requestId);
    return original.length > 0 ? [note, ...original] : [note];
  }

  /** The input blocks of the request that never reached the model. */
  private async originalInput(threadId: string, requestId: string): Promise<InputBlock[]> {
    const rows = await this.latestTurn(threadId);
    const row = rows.find(
      (item) => item.type === "client/turn/requested" && str(record(item.data).requestId) === requestId,
    );
    const input = record(row?.data).input;
    return Array.isArray(input) ? input.filter((block): block is InputBlock => typeof record(block).type === "string") : [];
  }

  // ---------- the person ----------

  async cancel(threadId: string): Promise<void> {
    await this.serial(threadId, async () => {
      const state = await this.load(threadId);
      const pending = state.pending;
      if (!pending || pending.dueAt === null) return;
      this.clearTimer(threadId);
      pending.dueAt = null;
      state.log.push({ kind: "cancelled", at: this.now(), from: pending.from, to: pending.to, reason: pending.reason });
      await this.save(threadId, state);
    });
  }

  async switchNow(threadId: string): Promise<void> {
    await this.run(threadId, true);
  }

  /** Puts the thread back on the model it ran on before the fallback. */
  async returnModel(threadId: string): Promise<void> {
    await this.serial(threadId, async () => {
      const state = await this.load(threadId);
      const active = state.active;
      if (!active) return;
      await this.sdk.setModel(threadId, active.original.id);
      state.active = null;
      state.notice = null;
      state.log.push({ kind: "returned", at: this.now(), to: active.original });
      await this.save(threadId, state);
    });
  }

  async view(threadId: string): Promise<ThreadView> {
    const state = await this.load(threadId);
    let ladder: ModelRef[] | null = null;
    const model = state.active?.current.id ?? state.pending?.from.id ?? null;
    const provider = state.pending?.provider ?? this.providers.get(threadId) ?? null;
    if (model !== null && provider !== null) {
      const found = this.config.ladders.find((item) => item.provider === provider && item.models.includes(model));
      if (found) {
        const named = new Map<string, string>();
        for (const ref of [state.active?.original, state.active?.current, state.pending?.from, state.pending?.to]) {
          if (ref) named.set(ref.id, ref.name);
        }
        ladder = found.models
          .filter((id) => this.config.policy.allows(provider, id))
          .map((id) => ({ id, name: named.get(id) ?? id }));
      }
    }
    return { state, ladder, now: this.now() };
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/**
 * The name people know a model by. ACP providers report `<provider>/<name>`
 * and bb greys out the provider part; the message and the page drop it.
 */
export function displayName(name: string): string {
  const slash = name.indexOf("/");
  const rest = slash >= 0 ? name.slice(slash + 1).trim() : name;
  return rest === "" ? name : rest;
}

/** The model the thread left in its latest switch. */
function lastFrom(state: ThreadState): ModelRef | null {
  for (let index = state.log.length - 1; index >= 0; index -= 1) {
    const entry = state.log[index];
    if (entry?.kind === "switched") return entry.from;
  }
  return null;
}
