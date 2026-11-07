import { afterEach, describe, expect, it } from "vitest";
import { Engine, type CatalogModel, type EngineConfig, type EngineSdk, type EventRow, type InputBlock, type ThreadInfo } from "../src/server/engine";
import { parseLadders } from "../src/shared/ladder";
import { createPolicy, parseRules } from "../src/shared/policy";
import type { ThreadState } from "../src/shared/state";

const MIN = 60_000;
const T = "thr_test1";

class FakeBb implements EngineSdk {
  now = 1_000_000;
  events: EventRow[] = [];
  thread: ThreadInfo = { id: T, providerId: "acp-opencode", status: "active", environmentId: "env_1", archived: false };
  models: CatalogModel[] = [
    { model: "corp/coder", displayName: "Coder" },
    { model: "corp/daily", displayName: "Daily" },
    { model: "corp/fast", displayName: "Fast" },
  ];
  connected = true;
  queuedRetry = false;
  running = true;
  calls: Array<[string, ...unknown[]]> = [];

  push(type: string, data: unknown = {}, at = this.now): void {
    this.events.push({ seq: this.events.length + 1, type, createdAt: at, data });
  }
  async getThread() {
    return { ...this.thread };
  }
  async listRunning() {
    return this.running ? [{ id: T, hostId: "host_1" }] : [];
  }
  async listEvents(
    _threadId: string,
    query: { order: "asc"; afterSeq: number } | { order: "desc"; beforeSeq: number | null },
    limit: number,
  ) {
    // Like bb: HTTP 400 above 100 rows per request.
    if (limit > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
    if (query.order === "asc") return this.events.filter((row) => row.seq > query.afterSeq).slice(0, limit);
    const before = query.beforeSeq;
    return [...this.events].reverse().filter((row) => before === null || row.seq < before).slice(0, limit);
  }
  async stop(threadId: string) {
    this.calls.push(["stop", threadId]);
    this.thread.status = "idle";
    this.push("system/thread/interrupted");
  }
  async setModel(threadId: string, model: string) {
    if (!this.models.some((item) => item.model === model)) throw new Error("400 model not in catalog");
    this.calls.push(["setModel", threadId, model]);
  }
  async send(threadId: string, model: string, input: InputBlock[]) {
    this.calls.push(["send", threadId, model, input]);
    this.push("client/turn/requested", { requestId: "creq_next", originPluginId: "model-fallback", execution: { model } });
  }
  async catalog() {
    return this.models;
  }
  async hostConnected() {
    return this.connected;
  }
  async hasQueuedRetry() {
    return this.queuedRetry;
  }
}

function setup(overrides: Partial<EngineConfig> = {}) {
  const bb = new FakeBb();
  const store = new Map<string, ThreadState>();
  const config: EngineConfig = {
    policy: createPolicy(parseRules("acp-opencode corp/*")),
    ladders: parseLadders("acp-opencode corp/coder > corp/daily > corp/fast"),
    graceMs: 30_000,
    limits: { thinkingMinutes: 7, answerMinutes: 6, silenceMinutes: 7 },
    language: "English",
    ...overrides,
  };
  const engine = new Engine(
    bb,
    {
      get: async (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),
      set: async (id, state) => void store.set(id, structuredClone(state)),
      threadIds: async () => [...store.keys()],
    },
    config,
    { pluginId: "model-fallback", now: () => bb.now, publish: () => {}, log: () => {}, sleep: async () => {} },
  );
  engines.push(engine);
  const state = () => store.get(T);
  return { bb, engine, state };
}

const engines: Engine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function startTurn(bb: FakeBb, model = "corp/coder", input: InputBlock[] = [{ type: "text", text: "do the review" }]) {
  bb.push("client/turn/requested", { requestId: "creq_1", execution: { model }, input });
  bb.push("turn/started");
}

const failure = (inputAccepted = true, errorInfo: { category: string; httpStatusCode: number | null } | null = null) => ({
  threadId: T,
  requestId: "creq_1",
  inputAccepted,
  errorInfo,
});

describe("failed turns", () => {
  it("counts down, then continues the thread on the next model", async () => {
    const { bb, engine, state } = setup();
    startTurn(bb);
    bb.push("provider/error", { message: "Provider error", detail: "429 Too Many Requests" });
    bb.push("turn/completed", { status: "failed" });
    bb.thread.status = "error";
    bb.running = false;
    await engine.onTurnFailed(failure());

    expect(state()?.pending).toMatchObject({ from: { id: "corp/coder", name: "Coder" }, to: { id: "corp/daily", name: "Daily" }, reason: { kind: "rate-limit" } });
    await engine.tick();
    expect(bb.calls).toEqual([]);

    bb.now += 31_000;
    await engine.tick();
    expect(bb.calls.map((call) => call.slice(0, 3))).toEqual([
      ["setModel", T, "corp/daily"],
      ["send", T, "corp/daily"],
    ]);
    const input = bb.calls[1]?.[3] as InputBlock[];
    expect(input).toHaveLength(1);
    expect(String(input[0]?.text)).toContain('"Coder" hit its rate limit');
    expect(state()?.pending).toBeNull();
    expect(state()?.active).toMatchObject({ original: { id: "corp/coder" }, current: { id: "corp/daily" } });

    // The continuation is recorded as the plugin's own, for the label in the timeline.
    bb.running = true;
    bb.thread.status = "active";
    await engine.tick();
    expect(state()?.sent).toHaveLength(1);
    expect(state()?.active).not.toBeNull();
  });

  it("sends the original request again when the model never accepted it", async () => {
    const { bb, engine } = setup({ graceMs: 0 });
    startTurn(bb, "corp/coder", [{ type: "text", text: "do the review" }]);
    bb.push("provider/error", { detail: "503 no_available_workers (all circuits open)" });
    bb.thread.status = "error";
    await engine.onTurnFailed(failure(false));
    const input = bb.calls.find((call) => call[0] === "send")?.[3] as InputBlock[];
    expect(input.map((block) => block.text)).toEqual([expect.stringContaining("never reached it"), "do the review"]);
  });

  it("leaves connection and key failures alone and says why", async () => {
    const { bb, engine, state } = setup();
    startTurn(bb);
    bb.push("provider/error", { detail: "Internal error: getaddrinfo ENOTFOUND api.example.com" });
    bb.thread.status = "error";
    await engine.onTurnFailed(failure(true, { category: "internal", httpStatusCode: null }));
    expect(state()?.pending).toBeNull();
    expect(state()?.notice).toMatchObject({ kind: "not-switched", why: "connection" });
    expect(bb.calls).toEqual([]);
  });

  it("says when the ladder has no model left", async () => {
    const { bb, engine, state } = setup();
    startTurn(bb, "corp/fast");
    bb.push("provider/error", { detail: "429" });
    bb.thread.status = "error";
    await engine.onTurnFailed(failure());
    expect(state()?.notice).toMatchObject({ kind: "no-fallback", model: { id: "corp/fast" } });
  });

  it("skips ladder models the machine does not offer and never leaves the allowed list", async () => {
    const { bb, engine, state } = setup({
      policy: createPolicy(parseRules("acp-opencode corp/coder\nacp-opencode corp/fast")),
    });
    startTurn(bb);
    bb.push("provider/error", { detail: "429" });
    bb.thread.status = "error";
    await engine.onTurnFailed(failure());
    expect(state()?.pending?.to.id).toBe("corp/fast");

    const second = setup();
    second.bb.models = second.bb.models.filter((item) => item.model !== "corp/daily");
    startTurn(second.bb);
    second.bb.push("provider/error", { detail: "429" });
    second.bb.thread.status = "error";
    await second.engine.onTurnFailed(failure());
    expect(second.state()?.pending?.to.id).toBe("corp/fast");
  });

  it("ignores models outside every ladder and turns provider-retry already re-runs", async () => {
    const { bb, engine, state } = setup();
    startTurn(bb, "corp/other");
    bb.push("provider/error", { detail: "429" });
    await engine.onTurnFailed(failure());
    expect(state()).toBeUndefined();

    const second = setup();
    startTurn(second.bb);
    second.bb.push("provider/error", { detail: "429" });
    second.bb.queuedRetry = true;
    await second.engine.onTurnFailed(failure());
    expect(second.state()).toBeUndefined();
  });
});

describe("hung turns", () => {
  it("reads a turn longer than one page of events", async () => {
    const { bb, engine, state } = setup();
    startTurn(bb);
    for (let i = 0; i < 250; i += 1) {
      bb.push("item/started", { item: { id: `t${i}`, type: "toolCall" } });
      bb.push("item/completed", { item: { id: `t${i}`, type: "toolCall" } });
    }
    bb.push("item/started", { item: { id: "r1", type: "reasoning" } });
    bb.now += 8 * MIN;
    await engine.tick();
    expect(state()?.pending).toMatchObject({ requestId: "creq_1", reason: { kind: "thinking" } });
  });

  it("stops a model that thinks too long and continues on the next one", async () => {
    const { bb, engine, state } = setup();
    startTurn(bb);
    bb.push("item/started", { item: { id: "r1", type: "reasoning" } });
    bb.now += 6 * MIN;
    await engine.tick();
    expect(state()?.pending ?? null).toBeNull();

    bb.now += 2 * MIN;
    await engine.tick();
    expect(state()?.pending).toMatchObject({ trigger: "hang", reason: { kind: "thinking", minutes: 8 }, to: { id: "corp/daily" } });

    bb.now += 31_000;
    await engine.tick();
    expect(bb.calls.map((call) => call[0])).toEqual(["stop", "setModel", "send"]);
    expect(String((bb.calls[2]?.[3] as InputBlock[])[0]?.text)).toContain("kept thinking for 8 min");
  });

  it("does nothing while the machine is offline: silence is not the model's fault then", async () => {
    const { bb, engine, state } = setup();
    startTurn(bb);
    bb.connected = false;
    bb.now += 20 * MIN;
    await engine.tick();
    expect(state()?.pending ?? null).toBeNull();
  });

  it("lets the model off when it comes back during the countdown", async () => {
    const { bb, engine, state } = setup();
    startTurn(bb);
    bb.push("item/started", { item: { id: "r1", type: "reasoning" } });
    bb.now += 8 * MIN;
    await engine.tick();
    expect(state()?.pending).not.toBeNull();
    bb.push("item/completed", { item: { id: "r1", type: "reasoning" } });
    bb.push("item/started", { item: { id: "a1", type: "agentMessage" } });
    bb.now += 31_000;
    await engine.tick();
    expect(bb.calls).toEqual([]);
    expect(state()?.pending).toBeNull();
    expect(state()?.log.at(-1)).toMatchObject({ kind: "recovered" });
  });
});

describe("the person decides", () => {
  async function hung() {
    const ctx = setup();
    startTurn(ctx.bb);
    ctx.bb.push("item/started", { item: { id: "r1", type: "reasoning" } });
    ctx.bb.now += 8 * MIN;
    await ctx.engine.tick();
    return ctx;
  }

  it("Cancel keeps the model waiting; Switch now still works afterwards", async () => {
    const { bb, engine, state } = await hung();
    await engine.cancel(T);
    expect(state()?.pending?.dueAt).toBeNull();
    bb.now += 5 * MIN;
    await engine.tick();
    expect(bb.calls).toEqual([]);
    expect(state()?.pending).not.toBeNull();

    await engine.switchNow(T);
    expect(bb.calls.map((call) => call[0])).toEqual(["stop", "setModel", "send"]);
  });

  it("Return puts the thread back on its first model", async () => {
    const { bb, engine, state } = await hung();
    await engine.switchNow(T);
    await engine.returnModel(T);
    expect(bb.calls.at(-1)).toEqual(["setModel", T, "corp/coder"]);
    expect(state()?.active).toBeNull();
    expect(state()?.log.at(-1)).toMatchObject({ kind: "returned", to: { id: "corp/coder" } });
  });

  it("a new turn on another model ends the fallback and drops a stale countdown", async () => {
    const { bb, engine, state } = await hung();
    await engine.switchNow(T);
    bb.push("client/turn/requested", { requestId: "creq_person", execution: { model: "corp/coder" } });
    bb.push("turn/started");
    await engine.tick();
    expect(state()?.active).toBeNull();
  });

  it("notices its own short turn and the person's model change between passes", async () => {
    const { bb, engine, state } = await hung();
    await engine.switchNow(T);
    // The fallback answered within a second: the thread is idle before the next pass.
    bb.push("turn/started");
    bb.push("turn/completed", { status: "completed" });
    bb.running = false;
    bb.thread.status = "idle";
    await engine.tick();
    expect(state()?.sent).toHaveLength(1);
    expect(state()?.sent[0]).toMatchObject({ from: { id: "corp/coder" }, to: { id: "corp/daily" } });

    // The person sends the next message on the first model; it also ends before a pass.
    bb.push("client/turn/requested", { requestId: "creq_person", execution: { model: "corp/coder" } });
    bb.push("turn/completed", { status: "completed" });
    await engine.onThreadEvents(T);
    expect(state()?.active).toBeNull();
  });

  it("the countdown ends quietly when the turn finishes by itself", async () => {
    const { bb, engine, state } = await hung();
    await engine.cancel(T);
    bb.push("turn/completed", { status: "completed" });
    bb.running = false;
    await engine.tick();
    expect(state()?.pending).toBeNull();
    expect(bb.calls).toEqual([]);
  });
});
