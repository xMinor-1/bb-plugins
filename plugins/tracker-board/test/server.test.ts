// The server end to end against the mock tracker: the board, edits from the panel,
// templates, and the agent's changes that wait for the person's confirmation.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import type { BoardView, IssueView } from "../src/server/rpc-contract";
import type { Issue } from "../src/shared/model";
import { messages } from "../src/app/messages";
import { errorText } from "../src/app/store";
import { TrackerHost } from "../src/host/service";
import { MOCK_KEY, MOCK_PROFILE, MOCK_TEMPLATES, startMockTracker } from "./fixtures/mock-tracker";
import { memoryStore } from "./memory-store";

let mock: Awaited<ReturnType<typeof startMockTracker>>;
beforeAll(async () => {
  mock = await startMockTracker();
});
afterAll(() => mock.close());

// Every setup leaves a fake host and a data folder; drop exactly those.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const ALLOWED = { providerId: "acp-opencode", model: "corp/large" };
const EXTERNAL = { providerId: "acp-opencode", model: "opencode/free-model" };

async function setup(settings: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "tb-srv-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TrackerHost({ dataDir, store: memoryStore() });
  await service.saveKey({ baseUrl: mock.url, key: MOCK_KEY });
  const spawned: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "tracker-board",
    settings: {
      trackerName: "Tracker",
      baseUrl: mock.url,
      apiProfile: JSON.stringify(MOCK_PROFILE),
      templates: JSON.stringify(MOCK_TEMPLATES),
      allowedModels: "acp-opencode corp/*",
      guide: "Queues: PAY.",
      ...settings,
    },
    agentSkillIds: ["tracker-board"],
    experimental_hostEntry: true,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_mac", providerId: "acp-opencode" }),
        spawn: async (args: unknown) => {
          spawned.push(args);
          return makeThreadResponse({ id: "thr_chat" });
        },
      },
      environments: { get: async () => ({ id: "env_mac", hostId: "host_mac" }) },
      hosts: { list: async () => [{ id: "host_mac", name: "Mac", status: "connected", lifecycle: { phase: "ready" } }] },
      system: { config: async () => ({ primaryHostId: "host_mac" }) },
      projects: { list: async () => [{ id: "proj_personal", kind: "personal" }] },
    } as never,
    experimental_callHostRpc: async ({ method, input }) => {
      const handler = (service as unknown as Record<string, (input: unknown) => unknown>)[method]!;
      if (method === "status" || method === "forget") return handler.call(service, (input as { baseUrl: string | null }).baseUrl);
      return handler.call(service, input);
    },
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  const rpc = <T>(method: string, input: unknown = null) => harness.behavior.callRpc(method, input) as Promise<T>;
  const tool = (name: string, params: Record<string, unknown>, threadId = "thr_agent") => harness.behavior.callAgentTool(name, params, { threadId });
  const dispatch = (threadId: string, execution: { providerId: string; model: string | null }, blocks: unknown[] = []) =>
    harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId }, requestedExecution: execution, input: { blocks, text: "" } } as never));
  const configure = (providerId: string, model: string) => harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model } }));
  return { harness, rpc, tool, dispatch, configure, spawned, service };
}

const text = (value: unknown) => JSON.stringify(value);
const issue = (key: string) => mock.state.issues.find((item) => item.key === key)!;
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

beforeEach(() => {
  mock.state.failWith = null;
});

describe("the board", () => {
  it("shows an epic with everything nested under it and names the assignees", async () => {
    const { rpc } = await setup();
    const board = await rpc<BoardView>("board", { source: { kind: "issue", key: "PAY-101" } });
    const keys = board.issues.map((item) => item.key);
    expect(keys[0]).toBe("PAY-101");
    expect(keys).toContain("PAY-112");
    expect(keys).toContain("PAY-140");
    expect(keys).not.toContain("OPS-1");
    expect(board.issues.find((item) => item.key === "PAY-112")?.assigneeName).toBe("Igor Vetrov");
    expect(board.me?.id).toBe("u1");
    expect(board.statuses.map((status) => status.key).slice(0, 6)).toEqual(["open", "ready", "in_progress", "review", "testing", "done"]);
    expect(board.title).toBe("PAY-101 Card payment in the mobile app");
  });

  it("follows a children query when the profile has one", async () => {
    const { rpc } = await setup({ apiProfile: JSON.stringify({ ...MOCK_PROFILE, queries: { ...MOCK_PROFILE.queries, children: "parent in ({keys})" } }) });
    const board = await rpc<BoardView>("board", { source: { kind: "issue", key: "PAY-120" } });
    expect(board.issues.map((item) => item.key).sort()).toEqual(["PAY-120", "PAY-121", "PAY-122"]);
    const searches = mock.state.requests.filter((request) => request.path.endsWith("/issues/_search")).map((request) => (request.body as { query: string }).query);
    expect(searches).toContain("parent in (PAY-120)");
  });

  it("loads the parents a board does not hold, by keys in one search", async () => {
    const { rpc } = await setup({ apiProfile: JSON.stringify({ ...MOCK_PROFILE, queries: { ...MOCK_PROFILE.queries, keys: "key in ({keys})" } }) });
    const board = await rpc<BoardView>("board", { source: { kind: "mine" } });
    // PAY-131 is mine; its story PAY-130 is nobody's, so only the parents list has it.
    expect(board.issues.map((item) => item.key)).not.toContain("PAY-130");
    expect(board.parents.map((item) => item.key)).toEqual(["PAY-130"]);
    const searches = mock.state.requests.filter((request) => request.path.endsWith("/issues/_search")).map((request) => (request.body as { query: string }).query);
    expect(searches).toContain("key in (PAY-130)");
  });

  it("reads parents one by one without a keys query, and up to the top for one issue", async () => {
    const { rpc } = await setup();
    const board = await rpc<BoardView>("board", { source: { kind: "mine" } });
    expect(board.parents.map((item) => item.key)).toEqual(["PAY-130"]);
    const view = await rpc<IssueView>("issue", { key: "PAY-112" });
    expect(view.parents.map((item) => item.key)).toEqual(["PAY-110", "PAY-101"]);
  });

  it("gives a parent's whole tree for the side panel without changing the board in view", async () => {
    const { rpc } = await setup();
    await rpc("board", { source: { kind: "mine" } });
    const before = await rpc<{ source: unknown; recent: unknown[] }>("prefs");
    const tree = await rpc<{ issues: Issue[]; truncated: boolean }>("tree", { key: "PAY-101" });
    const keys = tree.issues.map((item) => item.key);
    expect(keys[0]).toBe("PAY-101");
    expect(keys).toEqual(expect.arrayContaining(["PAY-110", "PAY-115", "PAY-130", "PAY-140", "PAY-150"]));
    expect(keys).not.toContain("OPS-1");
    expect(tree.truncated).toBe(false);
    const after = await rpc<{ source: unknown; recent: unknown[] }>("prefs");
    expect(after.source).toEqual(before.source);
    expect(after.recent).toEqual(before.recent);
  });

  it("finds queues by name, without archived ones", async () => {
    const { rpc } = await setup();
    expect(await rpc("queues", { text: "pay" })).toEqual({ queues: [{ key: "PAY", name: "Payments" }] });
    expect(await rpc("queues", { text: "p" })).toEqual({ queues: [] });
  });

  it("suggests the queues and open epics of the person's own tasks", async () => {
    const { rpc } = await setup();
    const suggestions = await rpc<{ queues: { key: string; name: string; count: number }[]; epics: { issue: { key: string }; count: number }[] }>("suggestBoards");
    expect(suggestions.queues[0]).toMatchObject({ key: "PAY", name: "Payments" });
    expect(suggestions.epics.map((item) => item.issue.key)).toEqual(["PAY-101"]);
  });

  it("gives the build's shared boards and names a pinned board when it loads", async () => {
    const { rpc } = await setup({ defaultBoards: "PAY\nOPS-1" });
    const config = await rpc<{ defaultBoards: unknown; can: { queues: boolean } }>("config");
    expect(config.defaultBoards).toEqual([{ kind: "queue", queue: "PAY" }, { kind: "issue", key: "OPS-1" }]);
    expect(config.can.queues).toBe(true);
    await rpc("setPrefs", { boards: [{ source: { kind: "issue", key: "PAY-101" }, title: "", hidden: false }] });
    await rpc("board", { source: { kind: "issue", key: "PAY-101" } });
    const prefs = await rpc<{ boards: { title: string }[] }>("prefs");
    expect(prefs.boards[0]?.title).toBe("PAY-101 Card payment in the mobile app");
  });

  it("opens one task with comments and remembers recent boards", async () => {
    const { rpc } = await setup();
    const view = await rpc<IssueView>("issue", { key: "PAY-110" });
    expect(view.issue.statusName).toBe("In progress");
    expect(view.comments?.[0]?.text).toContain("callback");
    expect(view.comments?.[0]?.authorName).toBe("Igor Vetrov");
    const board = await rpc<BoardView>("board", { source: { kind: "queue", queue: "OPS" } });
    // A queue board reads by the queue's name, not its key.
    expect(board.title).toBe("Operations");
    const prefs = await rpc<{ recent: { title: string }[]; source: unknown }>("prefs");
    expect(prefs.source).toEqual({ kind: "queue", queue: "OPS" });
    expect(prefs.recent[0]?.title).toBe("Operations");
  });

  it("keeps the type of an issue board's root for its icon in the lists", async () => {
    const { rpc } = await setup();
    await rpc("setPrefs", { boards: [{ source: { kind: "issue", key: "PAY-101" }, title: "", hidden: false }] });
    await rpc("board", { source: { kind: "issue", key: "PAY-101" } });
    const prefs = await rpc<{ recent: { kind?: string }[]; boards: { kind?: string }[] }>("prefs");
    expect(prefs.recent[0]?.kind).toBe("epic");
    expect(prefs.boards[0]?.kind).toBe("epic");
  });

  it("saves one part of the prefs without resetting the board in view", async () => {
    const { rpc } = await setup();
    await rpc("board", { source: { kind: "queue", queue: "OPS" } });
    const display = { view: "list", group: "story", fields: ["key", "assignee"], clamp: 2, width: "wide", chat: "bottom", chatHeight: 60 };
    const saved = await rpc<{ display: unknown; source: unknown; recent: unknown[] }>("setPrefs", { display });
    expect(saved.display).toEqual(display);
    expect(saved.source).toEqual({ kind: "queue", queue: "OPS" });
    expect(saved.recent).toHaveLength(1);
    const again = await rpc<{ source: unknown; display: unknown }>("prefs");
    expect(again.source).toEqual({ kind: "queue", queue: "OPS" });
    expect(again.display).toEqual(display);
  });

  it("checks the key and words a refusal", async () => {
    const { rpc } = await setup();
    expect(await rpc("checkKey")).toMatchObject({ ok: true, me: { name: "Anna Smirnova" } });
    expect(await rpc("saveKey", { key: "wrong" })).toMatchObject({ ok: false, code: "unauthorized" });
    await expect(rpc("board", { source: { kind: "queue", queue: "PAY" } })).rejects.toThrow(/tracker-board:unauthorized/);
  });

  it("tells a build's setup page whether the key works, from the saved state", async () => {
    const { rpc, harness } = await setup();
    await rpc("checkKey");
    const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "fleet-kit" } };
    expect(await harness.behavior.callRpc("setupStatus", { lang: "ru" }, asPlugin)).toEqual({ state: "done", summary: "Ключ API работает", path: "/plugins/tracker-board/board" });
    const unchecked = await setup();
    expect(await unchecked.harness.behavior.callRpc("setupStatus", {}, asPlugin)).toMatchObject({ state: "todo", summary: "The key is saved but not checked yet" });
    const fresh = await setup({ baseUrl: "" });
    expect(await fresh.harness.behavior.callRpc("setupStatus", {}, asPlugin)).toMatchObject({ state: "problem", summary: "This build does not set up the tracker yet" });
  });

  it("words a refused request with the tracker's own message and the machine it went from", async () => {
    const { rpc } = await setup({ allowQuery: true });
    const error = await rpc("board", { source: { kind: "query", query: "summary like nothing" } }).catch((cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("tracker-board:badRequest:400 ");
    expect(JSON.parse(message.slice(message.indexOf("{")))).toEqual({ detail: "parse error: unexpected clause: summary like nothing", machine: "Mac" });
    const ru = errorText(messages.ru, error);
    expect(ru).toBe("Трекер отклонил запрос. Ответ трекера: «parse error: unexpected clause: summary like nothing». Запрос шёл с машины Mac.");
    expect(errorText(messages.en, new Error('tracker-board:unauthorized:401 {"detail":null,"machine":"Mac"}'))).toBe("The tracker refused the API key. Save a new one in Settings. The request went from Mac.");
  });

  it("keeps a board's statuses to the configured ones and those its cards are in", async () => {
    const profile = { ...MOCK_PROFILE, statuses: MOCK_PROFILE.statuses.map((status) => (status.key === "testing" ? { ...status, show: "used" } : status)) };
    const { rpc } = await setup({ apiProfile: JSON.stringify(profile) });
    const config = await rpc<{ statuses: { key: string }[] }>("config");
    expect(config.statuses.map((status) => status.key)).not.toContain("testing");
    expect(config.statuses.map((status) => status.key)).toContain("review");
    const board = await rpc<{ statuses: { key: string }[] }>("board", { source: { kind: "issue", key: "PAY-101" } });
    expect(board.statuses.map((status) => status.key)).toContain("testing");
  });

  it("answers no other plugin", async () => {
    const { harness } = await setup();
    await expect(harness.behavior.callRpc("board", { source: { kind: "queue", queue: "PAY" } }, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow(/other plugins/);
  });
});

describe("changes from the panel", () => {
  it("previews, skips what is already so, and applies the rest", async () => {
    const { rpc, harness } = await setup();
    const changes = [
      { kind: "status", key: "PAY-122", to: "in_progress" },
      { kind: "status", key: "PAY-111", to: "done" },
      { kind: "assignee", key: "PAY-115", to: "u5" },
      { kind: "labels", key: "PAY-113", add: ["TEAM-RELEASE-Q426"], remove: [] },
      { kind: "parent", key: "PAY-150", to: "PAY-130" },
    ];
    const planned = await rpc<{ id: string; ok: boolean; skip: string | null; from: string | null; to: string | null }[]>("preview", { changes });
    expect(planned.map((item) => item.ok)).toEqual([true, false, true, true, true]);
    expect(planned[1]!.skip).toBe("same");
    expect(planned[0]).toMatchObject({ from: "In progress".replace("In progress", "Ready for development"), to: "In progress" });
    const { results } = await rpc<{ results: { ok: boolean }[] }>("apply", { changes, approve: planned.filter((item) => item.ok).map((item) => item.id) });
    expect(results.every((result) => result.ok)).toBe(true);
    expect(issue("PAY-122").status).toBe("in_progress");
    expect(issue("PAY-115").assignee_id).toBe("u5");
    expect(issue("PAY-113").labels).toEqual(["TEAM-FRONTEND-Q426", "TEAM-RELEASE-Q426"]);
    expect(issue("PAY-150").parent_key).toBe("PAY-130");
    expect(harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");
  });

  it("removes a parent with the profile's DELETE request", async () => {
    const { rpc } = await setup();
    const changes = [{ kind: "parent", key: "PAY-113", to: null }];
    const planned = await rpc<{ id: string; ok: boolean }[]>("preview", { changes });
    expect(planned[0]?.ok).toBe(true);
    const { results } = await rpc<{ results: { ok: boolean }[] }>("apply", { changes, approve: [planned[0]!.id] });
    expect(results[0]?.ok).toBe(true);
    expect(issue("PAY-113").parent_key).toBeNull();
    expect(mock.state.requests.some((request) => request.method === "DELETE" && request.path.endsWith("/issues/PAY-113/parent"))).toBe(true);
  });

  it("refuses a parent below the issue itself", async () => {
    const { rpc } = await setup();
    const planned = await rpc<{ ok: boolean; skip: string | null }[]>("preview", { changes: [{ kind: "parent", key: "PAY-101", to: "PAY-110" }, { kind: "parent", key: "PAY-110", to: "PAY-110" }] });
    expect(planned.map((item) => item.skip)).toEqual(["cycle", "selfParent"]);
  });

  it("creates a story with tasks under it, in order, with labels, assignee and parent", async () => {
    const { rpc, harness } = await setup();
    const changes = [
      { kind: "create", ref: "r1", parentKey: "PAY-101", summary: "[S] Apple Pay", type: "story", assignee: "@me", labels: [] },
      { kind: "create", ref: "r2", parentRef: "r1", summary: "[BE] Apple Pay", type: "task", labels: ["TEAM-BACKEND-Q426"], components: ["Backend"], assignee: "u2" },
    ];
    const { results } = await rpc<{ results: { ok: boolean; key: string | null }[] }>("apply", { changes, approve: ["c1", "c2"] });
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    const story = issue(results[0]!.key!);
    const task = issue(results[1]!.key!);
    expect(story).toMatchObject({ summary: "[S] Apple Pay", type: "story", parent_key: "PAY-101", assignee_id: "u1", queue_key: "PAY" });
    expect(task).toMatchObject({ parent_key: story.key, assignee_id: "u2", labels: ["TEAM-BACKEND-Q426"] });
    expect(mock.state.requests.some((request) => request.path.endsWith(`/issues/${task.id}/components`) && (request.body as { component_id: string }).component_id === "comp-1")).toBe(true);
    // The epic's open panel and the parents' trees read their children again.
    expect((harness.inspection.realtimeSignals.at(-1)?.payload as { keys: string[] }).keys).toEqual(expect.arrayContaining([story.key, task.key, "PAY-101"]));
  });

  it("fills create variables nobody gave from the profile's createDefaults", async () => {
    const { rpc } = await setup({ apiProfile: JSON.stringify({ ...MOCK_PROFILE, createDefaults: { priority: "low", type: "bug" } }) });
    const changes = [{ kind: "create", ref: "r1", parentKey: "PAY-120", summary: "[QA] Saved cards", type: "task", priority: "", labels: [] }];
    const { results } = await rpc<{ results: { ok: boolean; key: string | null }[] }>("apply", { changes, approve: ["c1"] });
    expect(results[0]?.ok).toBe(true);
    expect(issue(results[0]!.key!)).toMatchObject({ priority: "low", type: "task" });
  });

  it("skips the children of a create that failed", async () => {
    const { rpc } = await setup();
    const changes = [
      { kind: "create", ref: "r1", parentKey: null, queue: null, summary: "No queue anywhere", type: "story" },
      { kind: "create", ref: "r2", parentRef: "r1", summary: "Child", type: "task" },
    ];
    const { results } = await rpc<{ results: { ok: boolean; code: string | null }[] }>("apply", { changes, approve: ["c1", "c2"] });
    expect(results.map((result) => [result.ok, result.code])).toEqual([
      [false, "badRequest"],
      [false, "parentFailed"],
    ]);
  });
});

describe("agents", () => {
  it("offers the tools only to allowed models", async () => {
    const { configure } = await setup();
    expect(text(await configure(ALLOWED.providerId, ALLOWED.model))).toContain("tracker_propose_changes");
    expect(text(await configure(EXTERNAL.providerId, EXTERNAL.model))).not.toContain("tracker_");
    const empty = await setup({ allowedModels: "" });
    expect(text(await empty.configure(ALLOWED.providerId, ALLOWED.model))).not.toContain("tracker_");
  });

  it("refuses the tools to a model the thread switched to", async () => {
    const { dispatch, tool } = await setup();
    await dispatch("thr_x", EXTERNAL);
    expect(text(await tool("tracker_search", { source: "PAY" }, "thr_x"))).toContain("not available");
  });

  it("reads issues for an allowed model and keeps the thread on allowed models", async () => {
    const { dispatch, tool } = await setup();
    await dispatch("thr_agent", ALLOWED);
    const found = text(await tool("tracker_search", { source: "PAY-120" }));
    expect(found).toContain("PAY-121");
    expect(found).toContain("Maria Kim");
    expect(text(await tool("tracker_get_issues", { keys: ["PAY-110"], comments: true }))).toContain("callback");
    const decision = await dispatch("thr_agent", EXTERNAL);
    expect(decision).toMatchObject({ action: "reject" });
  });

  it("holds a message that mentions a task to the allowed models", async () => {
    const { dispatch } = await setup();
    const blocks = [{ type: "text", text: "@PAY-110 move it", mentions: [{ start: 0, end: 8, resource: { kind: "plugin", pluginId: "tracker-board", itemId: "issues:PAY-110", label: "PAY-110" } }] }];
    expect(await dispatch("thr_m", EXTERNAL, blocks)).toMatchObject({ action: "reject" });
    expect(await dispatch("thr_m2", ALLOWED, blocks)).toMatchObject({ action: "proceed" });
  });

  it("changes nothing until the person confirms, then applies only what they kept", async () => {
    const { dispatch, tool, harness } = await setup();
    await dispatch("thr_agent", ALLOWED);
    const before = { s: issue("PAY-121").status, a: issue("PAY-122").assignee_id };
    const pending = tool("tracker_propose_changes", {
      summary: "Move design to review and give the backend to Oleg",
      changes: [
        { kind: "status", key: "PAY-121", to: "review" },
        { kind: "assignee", key: "PAY-122", to: "u4" },
        { kind: "status", key: "PAY-111", to: "done" },
      ],
    });
    await waitFor(() => harness.inspection.pendingInteractions.length === 1);
    const form = harness.inspection.pendingInteractions[0]!;
    expect(form.rendererId).toBe("confirm-changes");
    const items = (form.payload as { items: { id: string; ok: boolean }[] }).items;
    expect(items.map((item) => item.ok)).toEqual([true, true, false]);
    expect(issue("PAY-121").status).toBe(before.s);
    harness.behavior.submitInteraction(form.id, { approve: ["c2"] });
    const answer = text(await pending);
    expect(answer).toContain("Applied 1 of 1");
    expect(answer).toContain("not approved by the user");
    expect(issue("PAY-121").status).toBe(before.s);
    expect(issue("PAY-122").assignee_id).toBe("u4");
  });

  it("changes nothing when the person rejects", async () => {
    const { dispatch, tool, harness } = await setup();
    await dispatch("thr_agent", ALLOWED);
    const pending = tool("tracker_propose_changes", { summary: "Close it", changes: [{ kind: "status", key: "PAY-131", to: "done" }] });
    await waitFor(() => harness.inspection.pendingInteractions.length === 1);
    harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0]!.id);
    expect(text(await pending)).toContain("rejected");
    expect(issue("PAY-131").status).toBe("in_progress");
  });

  it("ignores approvals for changes that were not offered", async () => {
    const { dispatch, tool, harness } = await setup();
    await dispatch("thr_agent", ALLOWED);
    const pending = tool("tracker_propose_changes", { summary: "x", changes: [{ kind: "status", key: "PAY-111", to: "done" }, { kind: "priority", key: "PAY-113", to: "high" }] });
    await waitFor(() => harness.inspection.pendingInteractions.length === 1);
    harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, { approve: ["c1", "c99"] });
    expect(text(await pending)).toContain("approved none");
    expect(issue("PAY-113").priority).toBe("medium");
  });
});

describe("agents without confirmation", () => {
  const directive = (answer: string) => /::tracker-changes\{id=\\?"(u_[0-9a-f]{12})\\?"\}/.exec(answer)?.[1] ?? null;
  type Applied = { items: { ok: boolean; canUndo: boolean; undo: string | null; planned: { key: string | null } }[]; undoneAt: number | null };

  it("follows the build's default, and the person's choice over it", async () => {
    const { configure, rpc } = await setup({ confirmAgentChanges: false });
    expect((await rpc<{ confirmDefault: boolean }>("config")).confirmDefault).toBe(false);
    const instructions = async () => ((await configure(ALLOWED.providerId, ALLOWED.model)) as { instructions: string }).instructions;
    expect(await instructions()).toContain("changes apply at once");
    await rpc("setPrefs", { confirmAgent: true });
    expect(await instructions()).toContain("confirms each change");
    const prefs = await rpc<{ confirmAgent: boolean | null }>("setPrefs", { confirmAgent: null });
    expect(prefs.confirmAgent).toBeNull();
    expect(await instructions()).toContain("changes apply at once");
    // Without the setting the build confirms.
    const plain = await setup();
    expect((await plain.rpc<{ confirmDefault: boolean }>("config")).confirmDefault).toBe(true);
  });

  it("applies at once, hands over the card, and undoes only what is still as set", async () => {
    const { dispatch, tool, harness, rpc } = await setup({ confirmAgentChanges: false });
    await dispatch("thr_agent", ALLOWED);
    const before = { status: issue("PAY-140").status, assignee: issue("PAY-150").assignee_id, labels: [...issue("PAY-114").labels] };
    const answer = text(
      await tool("tracker_propose_changes", {
        summary: "Close the bug, hand the contract to Oleg, tag the analysis",
        changes: [
          { kind: "status", key: "PAY-140", to: "done" },
          { kind: "assignee", key: "PAY-150", to: "u4" },
          { kind: "labels", key: "PAY-114", add: ["urgent"] },
          { kind: "comment", key: "PAY-114", text: "Tagged by the agent" },
        ],
      }),
    );
    // No form: the changes are in the tracker already.
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    expect(answer).toContain("Applied 4 of 4");
    expect(issue("PAY-140").status).toBe("done");
    expect(issue("PAY-150").assignee_id).toBe("u4");
    expect(issue("PAY-114").labels).toContain("urgent");
    const id = directive(answer);
    expect(id).not.toBeNull();
    expect(harness.inspection.realtimeSignals.at(-1)?.channel).toBe("changed");

    const view = await rpc<Applied>("appliedChanges", { id, threadId: "thr_agent" });
    expect(view.items.map((item) => item.canUndo)).toEqual([true, true, true, false]);
    // A card pasted into another thread shows nothing.
    await expect(rpc("appliedChanges", { id, threadId: "thr_other" })).rejects.toThrow(/notFound/);

    // Someone reassigns the contract meanwhile: that stays theirs.
    issue("PAY-150").assignee_id = "u2";
    const undone = await rpc<Applied>("undoApplied", { id, threadId: "thr_agent" });
    expect(undone.items.map((item) => item.undo)).toEqual(["undone", "changedSince", "undone", null]);
    expect(undone.undoneAt).not.toBeNull();
    expect(issue("PAY-140").status).toBe(before.status);
    expect(issue("PAY-150").assignee_id).toBe("u2");
    expect(issue("PAY-114").labels).toEqual(before.labels);
    // A second press changes nothing more.
    issue("PAY-140").status = "done";
    await rpc("undoApplied", { id, threadId: "thr_agent" });
    expect(issue("PAY-140").status).toBe("done");
    issue("PAY-140").status = before.status;
    issue("PAY-150").assignee_id = before.assignee;
  });

  it("keeps the form when the person wants to confirm, though the build does not", async () => {
    const { dispatch, tool, harness, rpc } = await setup({ confirmAgentChanges: false });
    await rpc("setPrefs", { confirmAgent: true });
    await dispatch("thr_agent", ALLOWED);
    const pending = tool("tracker_propose_changes", { summary: "Close it", changes: [{ kind: "status", key: "PAY-131", to: "done" }] });
    await waitFor(() => harness.inspection.pendingInteractions.length === 1);
    harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0]!.id);
    expect(text(await pending)).toContain("rejected");
    expect(issue("PAY-131").status).toBe("in_progress");
  });

  it("still refuses a model outside the allowed list", async () => {
    const { dispatch, tool } = await setup({ confirmAgentChanges: false });
    await dispatch("thr_x", EXTERNAL);
    expect(text(await tool("tracker_propose_changes", { summary: "x", changes: [{ kind: "status", key: "PAY-131", to: "done" }] }, "thr_x"))).toContain("not available");
    expect(issue("PAY-131").status).toBe("in_progress");
  });
});

describe("the chat next to the board", () => {
  it("starts a thread from the composer's request and remembers it", async () => {
    const { rpc, spawned } = await setup();
    expect(await rpc("chat")).toMatchObject({ threadId: null, projectId: "proj_personal", hostId: "host_mac" });
    await rpc("startChat", { request: { projectId: "proj_personal", input: [{ type: "text", text: "hi" }] } });
    expect(spawned).toHaveLength(1);
    expect(await rpc("chat")).toMatchObject({ threadId: "thr_chat" });
    await rpc("setChat", { threadId: null });
    expect(await rpc("chat")).toMatchObject({ threadId: null });
  });
});
