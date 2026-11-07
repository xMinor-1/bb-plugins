import { describe, expect, it } from "vitest";
import { OpencodeCollector, type StoredReading } from "../src/opencode/collector";
import type { OpencodeReadResult, OpencodeRow } from "../src/opencode/reader";
import { arrangeGroups, claudeGroup, isCorporate, opencodeGroups, parsePrefixes } from "../src/tokens";

const row = (over: Partial<OpencodeRow>): OpencodeRow => ({
  providerId: "zen",
  modelId: "free",
  bucket: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  requests: 0,
  ...over,
});

describe("corporate prefixes", () => {
  it("reads commas, spaces, new lines and a trailing star", () => {
    expect(parsePrefixes(" acme/, Other/*\n coder ")).toEqual(["acme/", "other/", "coder"]);
    expect(parsePrefixes("")).toEqual([]);
  });

  it("matches provider/model from the start, ignoring case", () => {
    const prefixes = parsePrefixes("acme/");
    expect(isCorporate("acme", "big", prefixes)).toBe(true);
    expect(isCorporate("ACME", "big", prefixes)).toBe(true);
    expect(isCorporate("acme-labs", "big", prefixes)).toBe(false);
    expect(isCorporate("zen", "acme/big", prefixes)).toBe(false);
    expect(isCorporate("acme", "big", [])).toBe(false);
  });
});

describe("opencodeGroups", () => {
  it("adds buckets up into windows and folds reasoning into output", () => {
    const [group] = opencodeGroups({
      hostId: "h",
      hostName: "Laptop",
      online: true,
      collectedAt: 5,
      problem: null,
      prefixes: [],
      rows: [
        row({ bucket: 0, input: 10, output: 1, reasoning: 2, cacheRead: 100, cacheWrite: 4, requests: 1 }),
        row({ bucket: 1, input: 20, output: 2, requests: 2 }),
        row({ bucket: 2, input: 30, output: 3, requests: 3 }),
      ],
    });
    const w = group!.models[0]!.windows;
    expect(w["5h"]).toEqual({ requests: 1, input: 10, output: 3, cacheRead: 100, cacheWrite: 4, total: 117 });
    expect(w["24h"]).toMatchObject({ requests: 3, input: 30, output: 5, total: 139 });
    expect(w["7d"]).toMatchObject({ requests: 6, input: 60, output: 8, total: 172 });
    expect(group).toMatchObject({ source: "opencode", providerId: "zen", corporate: false, hostName: "Laptop" });
  });

  it("puts corporate models into one group first, with bare ids when they share a provider", () => {
    const groups = opencodeGroups({
      hostId: "h",
      hostName: "Laptop",
      online: true,
      collectedAt: 5,
      problem: null,
      prefixes: parsePrefixes("acme/"),
      rows: [
        row({ providerId: "zen", modelId: "free", input: 1000 }),
        row({ providerId: "acme", modelId: "coder-large", input: 5 }),
        row({ providerId: "acme", modelId: "coder-small", input: 7 }),
      ],
    });
    expect(groups.map((g) => [g.providerId, g.corporate])).toEqual([["corporate", true], ["zen", false]]);
    expect(groups[0]!.models.map((m) => m.id)).toEqual(["coder-small", "coder-large"]);
  });

  it("keeps a machine whose database failed visible, but not one without OpenCode", () => {
    const base = { hostId: "h", hostName: "Laptop", online: true, collectedAt: null, prefixes: [], rows: [] };
    expect(opencodeGroups({ ...base, problem: "error" })).toMatchObject([{ problem: "error", models: [] }]);
    expect(opencodeGroups({ ...base, problem: "not_found" })).toEqual([]);
    expect(opencodeGroups({ ...base, problem: null })).toEqual([]);
  });
});

describe("claudeGroup and order", () => {
  const perWindow = {
    "5h": [{ model: "claude-opus", calls: 1, input: 1, output: 1, cacheCreation: 1, cacheRead: 1 }],
    "24h": [
      { model: "claude-opus", calls: 2, input: 2, output: 2, cacheCreation: 2, cacheRead: 2 },
      { model: "<synthetic>", calls: 9, input: 9, output: 9, cacheCreation: 9, cacheRead: 9 },
    ],
    "7d": [
      { model: "claude-opus", calls: 3, input: 3, output: 3, cacheCreation: 3, cacheRead: 3 },
      { model: "claude-haiku", calls: 1, input: 1, output: 0, cacheCreation: 0, cacheRead: 0 },
    ],
  };

  it("maps Claude Code's counters and drops synthetic entries", () => {
    const group = claudeGroup({ hostId: "s", hostName: "Server", perWindow, collectedAt: 1, prefixes: [] })!;
    expect(group.models.map((m) => m.id)).toEqual(["claude-opus", "claude-haiku"]);
    expect(group.models[0]!.windows["24h"]).toEqual({ requests: 2, input: 2, output: 2, cacheRead: 2, cacheWrite: 2, total: 8 });
    expect(group.models[1]!.windows["5h"].total).toBe(0);
    expect(claudeGroup({ hostId: "s", hostName: "S", perWindow: { "5h": [], "24h": [], "7d": [] }, collectedAt: 1, prefixes: [] })).toBeNull();
  });

  it("orders Claude Code, then corporate, then the rest; corporate-only hides the rest", () => {
    const claude = claudeGroup({ hostId: "s", hostName: "Server", perWindow, collectedAt: 1, prefixes: [] })!;
    const oc = opencodeGroups({
      hostId: "h",
      hostName: "Laptop",
      online: true,
      collectedAt: 5,
      problem: null,
      prefixes: ["acme/"],
      rows: [row({ providerId: "zen", input: 10_000 }), row({ providerId: "acme", modelId: "c", input: 1 })],
    });
    const all = arrangeGroups([...oc, claude], false);
    expect(all.map((g) => (g.source === "claude-code" ? "claude" : g.corporate ? "corp" : g.providerId))).toEqual(["claude", "corp", "zen"]);
    expect(arrangeGroups([...oc, claude], true).map((g) => g.providerId)).toEqual(["corporate"]);
  });
});

describe("OpencodeCollector", () => {
  function harness() {
    let now = 10_000_000;
    const store = new Map<string, StoredReading>();
    const reads: string[] = [];
    const answers: Record<string, () => OpencodeReadResult> = {
      laptop: () => ({ status: "ok", dbPath: "/x/opencode.db", schema: "v2", rows: [row({ input: 1 })] }),
      server: () => ({ status: "not_found", dbPath: null, schema: null, rows: [] }),
    };
    let hosts = [
      { id: "laptop", name: "Laptop", status: "connected" as "connected" | "disconnected" },
      { id: "server", name: "Server", status: "connected" as "connected" | "disconnected" },
    ];
    const collector = new OpencodeCollector({
      hosts: async () => hosts,
      read: async (hostId) => {
        reads.push(hostId);
        return answers[hostId]!();
      },
      load: async (id) => store.get(id),
      save: async (id, r) => void store.set(id, r),
      forget: async (id) => void store.delete(id),
      storedHosts: async () => [...store.keys()],
      now: () => now,
    });
    return {
      collector,
      reads,
      store,
      answers,
      tick: (ms: number) => (now += ms),
      setHosts: (next: typeof hosts) => (hosts = next),
    };
  }

  it("reads connected machines, skips those without OpenCode, and reuses recent answers", async () => {
    const h = harness();
    const out = await h.collector.get({ maxAgeMs: 60_000, force: false });
    expect(out.map((m) => [m.hostId, m.problem])).toEqual([["laptop", null]]);
    expect(h.store.get("laptop")?.collectedAt).toBe(10_000_000);
    await h.collector.get({ maxAgeMs: 60_000, force: false });
    expect(h.reads).toEqual(["laptop", "server"]);
    h.tick(61_000);
    await h.collector.get({ maxAgeMs: 60_000, force: false });
    expect(h.reads).toHaveLength(4);
  });

  it("shows an offline machine's last answer, dated, and drops it after a week", async () => {
    const h = harness();
    await h.collector.get({ maxAgeMs: 0, force: false });
    h.setHosts([{ id: "laptop", name: "Laptop", status: "disconnected" }]);
    h.tick(3_600_000);
    let out = await h.collector.get({ maxAgeMs: 0, force: false });
    expect(out).toMatchObject([{ hostId: "laptop", online: false, problem: "offline", reading: { collectedAt: 10_000_000 } }]);
    h.tick(8 * 24 * 3_600_000);
    out = await h.collector.get({ maxAgeMs: 0, force: false });
    expect(out).toEqual([]);
    expect(h.store.has("laptop")).toBe(false);
  });

  it("keeps the last answer when a read fails", async () => {
    const h = harness();
    await h.collector.get({ maxAgeMs: 0, force: false });
    h.answers.laptop = () => {
      throw new Error("host timed out");
    };
    h.tick(1000);
    const out = await h.collector.get({ maxAgeMs: 0, force: false });
    expect(out).toMatchObject([{ hostId: "laptop", problem: "error", reading: { collectedAt: 10_000_000 } }]);
  });
});
