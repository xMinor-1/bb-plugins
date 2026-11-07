// Plan limits of every provider, gathered from the usage sources bb's provider
// plugins publish — the same sources bb's builtin Provider usage panel reads.
// The aggregation follows that panel's server (plugins/provider-usage/server.ts
// in github.com/get-bb/bb, MIT License, Copyright (c) 2026 Michael Yong; see
// THIRD_PARTY_NOTICES.md), with two additions:
//
//  - a failing source is asked ever more rarely, from five minutes up to an
//    hour (Anthropic's usage check refuses for up to an hour, and every call
//    in that hour can earn the next refusal);
//  - while Claude Code's own check fails on the server's machine, fresh
//    figures from a local limits file stand in for it (feed.ts).
//
// Sources are asked with `refresh: false` unless a person presses Refresh, so
// the provider's own cache answers most calls.
import type { LimitsFeed } from "./feed";
import { feedWindowKind } from "./feed";
import { planLabel, selectUsageResources } from "./normalize";
import type { UsageMeasurement, UsageResourceList } from "./source-contract";
import type { LimitAccount, LimitWindow, LimitsSnapshot, MachineInfo } from "../shared/types";

type Resource = UsageResourceList["resources"][number];

export interface CollectorDeps {
  /** This plugin's id: its own source is not read back through RPC. */
  selfId: string;
  discover(): Promise<Array<{ pluginId: string; displayName: string }>>;
  list(pluginId: string): Promise<UsageResourceList>;
  fetch(pluginId: string, resourceId: string, refresh: boolean): Promise<UsageMeasurement>;
  hosts(): Promise<Array<{ id: string; name: string; status: "connected" | "disconnected" }>>;
  primaryHostId(): Promise<string | null>;
  providers(): Promise<Array<{ id: string; displayName: string }>>;
  readFeed(): Promise<LimitsFeed | null>;
  now(): number;
  log?: { info(message: string): void; warn(message: string): void };
}

export const CLAUDE_PROVIDER_ID = "claude-code";
/** Usage Meter's own stand-in row: this plugin covers the same file itself. */
const LEGACY_FEED = { pluginId: "usage-meter", resourceId: "claude-code-feed" };

const MIN_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
/** Refresh presses closer together than this reuse the last answer. */
const FORCE_GAP_MS = 30_000;
const BATCH = 3;

interface Inventory {
  pluginId: string;
  displayName: string;
  label: string | null;
  resources: Resource[];
  error: boolean;
}

interface Attempt {
  at: number;
  /** Current backoff step after a failure; 0 after a success. */
  delay: number;
  failed: boolean;
}

const keyOf = (pluginId: string, resourceId: string) => JSON.stringify([pluginId, resourceId]);

async function inBatches<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH) await Promise.all(items.slice(i, i + BATCH).map(run));
}

function toWindow(window: Extract<UsageMeasurement["usage"], { status: "ok" }>["windows"][number]): LimitWindow {
  return {
    kind: window.kind,
    label: window.label,
    model: window.model,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    cost: window.cost,
  };
}

export class LimitsCollector {
  private inventories = new Map<string, Inventory>();
  private measurements = new Map<string, { value: UsageMeasurement; loadedAt: number }>();
  private attempts = new Map<string, Attempt>();
  private running: { force: boolean; promise: Promise<LimitsSnapshot> } | null = null;
  private last: LimitsSnapshot | null = null;
  private feedActive = false;

  constructor(private deps: CollectorDeps) {}

  /** The last snapshot, or null before the first refresh. */
  snapshot(): LimitsSnapshot | null {
    return this.last;
  }

  /** True while the limits file stands in for Claude Code's refused check. */
  feeding(): boolean {
    return this.feedActive;
  }

  /** A snapshot no older than `maxAgeMs`; `force` asks sources for fresh figures. */
  async get(options: { maxAgeMs: number; force: boolean }): Promise<LimitsSnapshot> {
    const now = this.deps.now();
    if (!options.force && this.last && now - this.last.updatedAt < options.maxAgeMs) return this.last;
    if (this.running) {
      if (!options.force || this.running.force) return this.running.promise;
      await this.running.promise.catch(() => undefined);
    }
    const promise = this.refresh(options).finally(() => {
      if (this.running?.promise === promise) this.running = null;
    });
    this.running = { force: options.force, promise };
    return promise;
  }

  private due(key: string, now: number, maxAgeMs: number, force: boolean): boolean {
    const attempt = this.attempts.get(key);
    if (attempt?.failed && now - attempt.at < attempt.delay) return false;
    if (force) return !attempt || now - attempt.at >= FORCE_GAP_MS;
    const cached = this.measurements.get(key);
    return !cached || now - cached.loadedAt >= maxAgeMs;
  }

  private async fetchOne(pluginId: string, resourceId: string, force: boolean): Promise<void> {
    const key = keyOf(pluginId, resourceId);
    const at = this.deps.now();
    const prev = this.attempts.get(key);
    try {
      const value = await this.deps.fetch(pluginId, resourceId, force);
      if (value.usage.status === "error") throw new Error(value.usage.message);
      this.measurements.set(key, { value, loadedAt: at });
      this.attempts.set(key, { at, delay: 0, failed: false });
    } catch (error) {
      const delay = Math.min(Math.max((prev?.delay ?? 0) * 2, MIN_RETRY_MS), MAX_RETRY_MS);
      if (!prev?.failed) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log?.warn(`${pluginId} ${resourceId}: ${message}; next try in ${Math.round(delay / 60_000)} min`);
      }
      this.attempts.set(key, { at, delay, failed: true });
    }
  }

  private async refresh({ maxAgeMs, force }: { maxAgeMs: number; force: boolean }): Promise<LimitsSnapshot> {
    const [hosts, sources, providers, primaryHostId] = await Promise.all([
      this.deps.hosts().catch(() => []),
      this.deps.discover().catch(() => []),
      this.deps.providers().catch(() => []),
      this.deps.primaryHostId().catch(() => null),
    ]);
    const others = sources.filter((source) => source.pluginId !== this.deps.selfId);
    for (const id of this.inventories.keys()) {
      if (!others.some((source) => source.pluginId === id)) this.inventories.delete(id);
    }
    await inBatches(others, async (source) => {
      try {
        const inventory = await this.deps.list(source.pluginId);
        this.inventories.set(source.pluginId, {
          pluginId: source.pluginId,
          displayName: source.displayName,
          label: inventory.label ?? null,
          resources: inventory.resources.filter(
            (r) => !(source.pluginId === LEGACY_FEED.pluginId && r.id === LEGACY_FEED.resourceId),
          ),
          error: false,
        });
      } catch {
        const previous = this.inventories.get(source.pluginId);
        this.inventories.set(source.pluginId, {
          pluginId: source.pluginId,
          displayName: source.displayName,
          label: previous?.label ?? null,
          resources: previous?.resources ?? [],
          error: true,
        });
      }
    });

    const connected = new Set(hosts.filter((h) => h.status === "connected").map((h) => h.id));
    const live = [...this.inventories.values()].flatMap((inventory) =>
      inventory.resources
        .filter((r) => r.scope.kind === "shared" || connected.has(r.scope.hostId))
        .map((resource) => ({ inventory, resource })),
    );
    const keys = new Set(
      [...this.inventories.values()].flatMap((inv) => inv.resources.map((r) => keyOf(inv.pluginId, r.id))),
    );
    for (const key of [...this.measurements.keys()]) if (!keys.has(key)) this.measurements.delete(key);
    for (const key of [...this.attempts.keys()]) if (!keys.has(key)) this.attempts.delete(key);

    const now = this.deps.now();
    await inBatches(
      live.filter(({ inventory, resource }) => this.due(keyOf(inventory.pluginId, resource.id), now, maxAgeMs, force)),
      ({ inventory, resource }) => this.fetchOne(inventory.pluginId, resource.id, force),
    );

    const providerName = new Map(providers.map((p) => [p.id, p.displayName]));
    const providerOrder = new Map(providers.map((p, i) => [p.id, i]));
    const hostName = new Map(hosts.map((h) => [h.id, h.name]));
    const accounts: LimitAccount[] = [];
    const locations = new Map<string, Array<{ inventory: Inventory; resource: Resource }>>();
    for (const item of [...this.inventories.values()].flatMap((inventory) =>
      inventory.resources.map((resource) => ({ inventory, resource })),
    )) {
      const location =
        item.resource.scope.kind === "shared" ? `source:${item.inventory.pluginId}` : item.resource.scope.hostId;
      locations.set(location, [...(locations.get(location) ?? []), item]);
    }
    for (const items of locations.values()) {
      const visible = selectUsageResources(items, ({ inventory, resource }) => ({
        providerId: resource.providerId,
        scope: resource.scope,
        accountKey: this.measurements.get(keyOf(inventory.pluginId, resource.id))?.value.accountKey ?? resource.accountKey,
      }));
      for (const { inventory, resource } of visible) {
        const key = keyOf(inventory.pluginId, resource.id);
        const measured = this.measurements.get(key)?.value;
        const usage = measured?.usage;
        const failed = (this.attempts.get(key)?.failed ?? false) || inventory.error;
        const shared = resource.scope.kind === "shared";
        accounts.push({
          id: `${inventory.pluginId}:${resource.id}`,
          providerId: resource.providerId,
          providerName: providerName.get(resource.providerId) ?? resource.providerId,
          hostId: shared ? null : (resource.scope as { hostId: string }).hostId,
          hostName: shared
            ? null
            : (hostName.get((resource.scope as { hostId: string }).hostId) ??
              (resource.scope as { hostName: string }).hostName),
          poolName: shared ? (inventory.label ?? inventory.displayName) : null,
          accountEmail: usage?.accountEmail ?? (shared ? resource.label : null),
          planLabel: usage ? planLabel(usage.plan, usage.planLabel) : null,
          status: usage ? usage.status : "unknown",
          message: usage?.status === "error" ? usage.message : null,
          windows: usage?.status === "ok" ? usage.windows.map(toWindow) : [],
          observedAt: measured?.observedAt ?? null,
          stale: failed && usage !== undefined,
          backup: null,
        });
      }
    }

    await this.applyFeed(accounts, primaryHostId, hostName);
    // A provider that is not installed on a machine has nothing to say there.
    const shown = accounts.filter((a) => a.status !== "not_installed");

    const machineIds = new Set(shown.map((a) => a.hostId).filter((id): id is string => id !== null));
    const machines: MachineInfo[] = hosts
      .filter((h) => machineIds.has(h.id) || h.id === primaryHostId)
      .map((h) => ({ id: h.id, name: h.name, status: h.status, primary: h.id === primaryHostId }))
      .sort((a, b) => Number(b.primary) - Number(a.primary));
    const machineOrder = new Map(machines.map((m, i) => [m.id, i]));
    shown.sort(
      (a, b) =>
        (a.hostId === null ? 1 : 0) - (b.hostId === null ? 1 : 0) ||
        (machineOrder.get(a.hostId ?? "") ?? 99) - (machineOrder.get(b.hostId ?? "") ?? 99) ||
        (providerOrder.get(a.providerId) ?? 99) - (providerOrder.get(b.providerId) ?? 99),
    );
    this.last = { accounts: shown, machines, updatedAt: this.deps.now() };
    return this.last;
  }

  /** Puts the limits file in for Claude Code on the server's machine while its check fails. */
  private async applyFeed(
    accounts: LimitAccount[],
    primaryHostId: string | null,
    hostName: Map<string, string>,
  ): Promise<void> {
    const local = primaryHostId
      ? accounts.filter((a) => a.providerId === CLAUDE_PROVIDER_ID && a.hostId === primaryHostId)
      : [];
    const healthy = local.some((a) => a.status === "ok" && !a.stale);
    // "expired" and "unauthenticated" are about the login itself: the file's
    // writer runs on the same login, so it cannot speak for it.
    const loginProblem = local.some((a) => a.status === "expired" || a.status === "unauthenticated");
    const feed = primaryHostId && !healthy && !loginProblem ? await this.deps.readFeed().catch(() => null) : null;
    if (Boolean(feed) !== this.feedActive) {
      this.feedActive = Boolean(feed);
      this.deps.log?.info(
        this.feedActive
          ? "claude code: showing the limits file while the provider's check fails"
          : "claude code: limits file no longer used",
      );
    }
    if (!feed || !primaryHostId) return;
    const windows: LimitWindow[] = feed.windows.map((w) => ({
      kind: feedWindowKind(w.label),
      label: w.label,
      model: null,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
      cost: null,
    }));
    const target = local.find((a) => a.status !== "not_installed") ?? local[0] ?? null;
    if (target) {
      target.status = "ok";
      target.message = null;
      target.windows = windows;
      target.stale = false;
      target.observedAt = Date.parse(feed.fetchedAt);
      target.backup = { fetchedAt: feed.fetchedAt };
      return;
    }
    accounts.push({
      id: `${this.deps.selfId}:claude-code-feed`,
      providerId: CLAUDE_PROVIDER_ID,
      providerName: "Claude Code",
      hostId: primaryHostId,
      hostName: hostName.get(primaryHostId) ?? primaryHostId,
      poolName: null,
      accountEmail: null,
      planLabel: null,
      status: "ok",
      message: null,
      windows,
      observedAt: Date.parse(feed.fetchedAt),
      stale: false,
      backup: { fetchedAt: feed.fetchedAt },
    });
  }
}
