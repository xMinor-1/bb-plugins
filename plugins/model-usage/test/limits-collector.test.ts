import { describe, expect, it } from "vitest";
import { LimitsCollector, type CollectorDeps } from "../src/limits/collector";
import type { UsageMeasurement, UsageResourceList } from "../src/limits/source-contract";
import type { LimitsFeed } from "../src/limits/feed";

const SERVER = { id: "host_server", name: "Server", status: "connected" as const };
const LAPTOP = { id: "host_laptop", name: "Laptop", status: "disconnected" as const };

function okUsage(five: number, week: number, accountKey: string | null = null): UsageMeasurement {
  return {
    accountKey,
    observedAt: 1,
    usage: {
      status: "ok",
      plan: { id: "max", multiplier: 20 },
      accountEmail: "me@example.com",
      planLabel: null,
      windows: [
        { kind: "five-hour", id: "5h", label: "Five-hour limit", usedPercent: five, resetsAt: null, model: null, cost: null },
        { kind: "weekly", id: "7d", label: "Weekly limit", usedPercent: week, resetsAt: null, model: null, cost: null },
      ],
    },
  };
}

function hostResource(id: string, providerId: string, host: { id: string; name: string } = SERVER) {
  return { accountKey: null, id, providerId, label: providerId, scope: { kind: "host" as const, hostId: host.id, hostName: host.name } };
}

function harness(over: Partial<CollectorDeps> & { answers?: Record<string, () => UsageMeasurement> } = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const inventories: Record<string, UsageResourceList> = {
    "provider-claude-code": { resources: [hostResource("cc-server", "claude-code"), hostResource("cc-laptop", "claude-code", LAPTOP)] },
    "provider-codex": { resources: [hostResource("codex-server", "codex")] },
    "usage-meter": { resources: [hostResource("claude-code-feed", "claude-code")] },
    "model-usage": { resources: [hostResource("claude-code-feed", "claude-code")] },
  };
  const answers: Record<string, () => UsageMeasurement> = {
    "cc-server": () => okUsage(30, 7),
    "codex-server": () => okUsage(35, 6),
    ...over.answers,
  };
  let feed: LimitsFeed | null = null;
  const deps: CollectorDeps = {
    selfId: "model-usage",
    discover: async () => Object.keys(inventories).map((pluginId) => ({ pluginId, displayName: pluginId })),
    list: async (pluginId) => inventories[pluginId]!,
    fetch: async (pluginId, resourceId, refresh) => {
      calls.push(`${pluginId}/${resourceId}${refresh ? "!" : ""}`);
      const answer = answers[resourceId];
      if (!answer) throw new Error("no answer");
      return answer();
    },
    hosts: async () => [SERVER, LAPTOP],
    primaryHostId: async () => SERVER.id,
    providers: async () => [
      { id: "claude-code", displayName: "Claude Code" },
      { id: "codex", displayName: "Codex" },
    ],
    readFeed: async () => feed,
    now: () => now,
    ...over,
  };
  return {
    collector: new LimitsCollector(deps),
    calls,
    tick: (ms: number) => (now += ms),
    setFeed: (next: LimitsFeed | null) => (feed = next),
  };
}

const MIN = 60_000;

describe("LimitsCollector", () => {
  it("reads every source but itself, only on connected machines, with the plan named", async () => {
    const { collector, calls } = harness();
    const snap = await collector.get({ maxAgeMs: 0, force: false });
    expect(calls.sort()).toEqual(["provider-claude-code/cc-server", "provider-codex/codex-server"]);
    const claude = snap.accounts.find((a) => a.id === "provider-claude-code:cc-server")!;
    expect(claude).toMatchObject({ status: "ok", planLabel: "Max (20x)", hostName: "Server", stale: false, backup: null });
    expect(claude.windows.map((w) => [w.kind, w.usedPercent])).toEqual([["five-hour", 30], ["weekly", 7]]);
    // Usage Meter's stand-in row is not shown twice.
    expect(snap.accounts.some((a) => a.id.startsWith("usage-meter:"))).toBe(false);
    expect(snap.machines[0]).toMatchObject({ id: SERVER.id, primary: true });
  });

  it("serves a recent snapshot without asking sources again", async () => {
    const { collector, calls, tick } = harness();
    await collector.get({ maxAgeMs: 2 * MIN, force: false });
    tick(MIN);
    await collector.get({ maxAgeMs: 2 * MIN, force: false });
    expect(calls).toHaveLength(2);
    tick(2 * MIN);
    await collector.get({ maxAgeMs: 2 * MIN, force: false });
    expect(calls).toHaveLength(4);
  });

  it("keeps the last figures of a failing source and asks it ever more rarely, up to an hour", async () => {
    let fail = false;
    const { collector, calls, tick } = harness({
      answers: {
        "cc-server": () => {
          if (fail) throw new Error("rate limited");
          return okUsage(30, 7);
        },
      },
    });
    await collector.get({ maxAgeMs: 0, force: false });
    fail = true;
    const times: number[] = [];
    let elapsed = 0;
    for (let i = 0; i < 200; i++) {
      tick(MIN);
      elapsed += MIN;
      const before = calls.filter((c) => c.includes("cc-server")).length;
      const snap = await collector.get({ maxAgeMs: 0, force: false });
      if (calls.filter((c) => c.includes("cc-server")).length > before) times.push(elapsed / MIN);
      const claude = snap.accounts.find((a) => a.id === "provider-claude-code:cc-server")!;
      expect(claude.stale || i === 0).toBe(true);
      expect(claude.windows[0]!.usedPercent).toBe(30);
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps.slice(0, 4)).toEqual([5, 10, 20, 40]);
    expect(Math.max(...gaps)).toBe(60);
    // A press of Refresh does not break through the backoff either.
    const before = calls.length;
    await collector.get({ maxAgeMs: 0, force: true });
    expect(calls.filter((c) => c.includes("cc-server")).length).toBe(calls.slice(0, before).filter((c) => c.includes("cc-server")).length);
  });

  it("shows the limits file for Claude Code only while its check fails", async () => {
    let fail = true;
    const { collector, setFeed, tick } = harness({
      answers: {
        "cc-server": () => {
          if (fail) throw new Error("rate limited");
          return okUsage(30, 7);
        },
      },
    });
    setFeed({
      fetchedAt: new Date(1_000_000).toISOString(),
      windows: [
        { label: "Current session", usedPercent: 12, resetsAt: null },
        { label: "Weekly limit", usedPercent: 21, resetsAt: null },
      ],
    });
    let snap = await collector.get({ maxAgeMs: 0, force: false });
    let claude = snap.accounts.filter((a) => a.providerId === "claude-code" && a.hostId === SERVER.id);
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({ status: "ok", backup: { fetchedAt: new Date(1_000_000).toISOString() } });
    expect(claude[0]!.windows.map((w) => [w.kind, w.usedPercent])).toEqual([["five-hour", 12], ["weekly", 21]]);
    expect(collector.feeding()).toBe(true);

    fail = false;
    tick(6 * MIN);
    snap = await collector.get({ maxAgeMs: 0, force: false });
    claude = snap.accounts.filter((a) => a.providerId === "claude-code" && a.hostId === SERVER.id);
    expect(claude[0]).toMatchObject({ backup: null, stale: false });
    expect(claude[0]!.windows[0]!.usedPercent).toBe(30);
    expect(collector.feeding()).toBe(false);
  });

  it("does not let the file speak for an expired login", async () => {
    const { collector, setFeed } = harness({
      answers: {
        "cc-server": () => ({ accountKey: null, observedAt: null, usage: { status: "expired", plan: null, accountEmail: null, planLabel: null } }),
      },
    });
    setFeed({ fetchedAt: new Date(1_000_000).toISOString(), windows: [{ label: "Current session", usedPercent: 12, resetsAt: null }] });
    const snap = await collector.get({ maxAgeMs: 0, force: false });
    const claude = snap.accounts.find((a) => a.id === "provider-claude-code:cc-server")!;
    expect(claude).toMatchObject({ status: "expired", backup: null });
    expect(collector.feeding()).toBe(false);
  });

  it("merges one known account seen by two sources", async () => {
    const { collector } = harness({
      list: async (pluginId) =>
        pluginId === "provider-claude-code"
          ? { resources: [hostResource("a", "claude-code")] }
          : pluginId === "provider-codex"
            ? { resources: [hostResource("b", "claude-code")] }
            : { resources: [] },
      answers: { a: () => okUsage(1, 1, "anthropic:org-1"), b: () => okUsage(2, 2, "anthropic:org-1") },
    });
    const snap = await collector.get({ maxAgeMs: 0, force: false });
    expect(snap.accounts.filter((a) => a.providerId === "claude-code")).toHaveLength(1);
  });
});

describe("LimitsCollector without Claude Code installed", () => {
  it("hides providers that are not installed, and the file takes the empty row's place", async () => {
    const notInstalled = (): UsageMeasurement => ({ accountKey: null, observedAt: null, usage: { status: "not_installed", plan: null, accountEmail: null, planLabel: null } });
    const { collector, setFeed } = harness({ answers: { "cc-server": notInstalled, "codex-server": notInstalled } });
    const onServer = <T extends { hostId: string | null }>(accounts: T[]) => accounts.filter((a) => a.hostId === SERVER.id);
    let snap = await collector.get({ maxAgeMs: 0, force: false });
    expect(onServer(snap.accounts)).toEqual([]);
    setFeed({ fetchedAt: new Date(1_000_000).toISOString(), windows: [{ label: "Current session", usedPercent: 12, resetsAt: null }] });
    snap = await collector.get({ maxAgeMs: 0, force: true });
    expect(onServer(snap.accounts).map((a) => [a.id, a.status])).toEqual([["provider-claude-code:cc-server", "ok"]]);
    expect(snap.accounts.find((a) => a.hostId === SERVER.id)?.backup).not.toBeNull();
  });
});
