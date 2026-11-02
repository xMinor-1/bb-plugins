// The server's guard: who gets the tools, who may run them, which turns a thread
// holding the data may not take, and what the tools send to the machine.
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { RequestOutput } from "../contract";
import plugin from "../server";

const ALLOWED = { providerId: "acp-opencode", model: "corp/large" };
const EXTERNAL = { providerId: "acp-opencode", model: "opencode/free-model" };
const METHODS = [
  { name: "items", path: "agent/items", summary: "List items", params: [{ name: "code", type: "string", required: true, description: "Item code" }], reference: "Full reference of items" },
  { name: "stages", path: "agent/stages", summary: "List stages" },
];
const SETTINGS = {
  allowedModels: "acp-opencode corp/*",
  serviceName: "Sales data",
  summary: "Answers questions about sales.",
  baseUrl: "https://svc.example.com/api/tools",
  methods: JSON.stringify(METHODS),
  checkMethod: "stages",
  guide: "# Rules\nBe exact.",
};

async function setup(settings: Partial<typeof SETTINGS> = {}, answer: RequestOutput = { ok: true, text: '{"data":"COMPANY DATA"}', truncated: false }) {
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  const parents = new Map<string, string>();
  const gone = new Set<string>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "http-data-service",
    settings: { ...SETTINGS, ...settings },
    agentSkillIds: ["http-data-service"],
    experimental_hostEntry: true,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (gone.has(threadId)) throw new Error("no such thread");
          return makeThreadResponse({ id: threadId, environmentId: "env_mac", providerId: "acp-opencode", sourceThreadId: parents.get(threadId) ?? null });
        },
      },
      environments: { get: async () => ({ id: "env_mac", hostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push({ method, input, hostId });
      return answer;
    },
  });
  await plugin(bb);
  const dispatch = (threadId: string, execution: { providerId: string; model: string | null }, sourceThreadId: string | null = null) =>
    harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId, sourceThreadId }, requestedExecution: execution }));
  const configure = (providerId: string, model: string) => harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model } }));
  const call = (threadId: string, params: Record<string, unknown> = { method: "stages" }) => harness.behavior.callAgentTool("data_service_call", params, { threadId });
  const guide = (threadId: string, params: Record<string, unknown> = {}) => harness.behavior.callAgentTool("data_service_guide", params, { threadId });
  const remove = async (threadId: string) => {
    const sourceThreadId = parents.get(threadId) ?? null;
    gone.add(threadId);
    await harness.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: threadId, sourceThreadId }) } as never);
  };
  return { harness, hostCalls, parents, remove, dispatch, configure, call, guide };
}

const text = (result: unknown) => JSON.stringify(result);

describe("agent configuration", () => {
  it("offers the tools, the skill and the method list only to allowed models", async () => {
    const { configure } = await setup();
    const allowed = text(await configure("acp-opencode", "corp/large"));
    for (const expected of ["data_service_call", "data_service_guide", "http-data-service", "Sales data", "Answers questions about sales.", "items, stages"]) {
      expect(allowed).toContain(expected);
    }
    for (const [provider, model] of [["acp-opencode", "opencode/free-model"], ["claude-code", "claude-opus-5-5"], ["codex", "gpt-5"]] as const) {
      const denied = text(await configure(provider, model));
      expect(denied, `${provider} ${model}`).not.toContain("data_service");
      expect(denied).not.toContain("Sales data");
    }
  });

  it("gives nobody the tools with an empty or broken list", async () => {
    for (const allowedModels of ["", "only-one-word"]) {
      const { configure } = await setup({ allowedModels });
      expect(text(await configure("acp-opencode", "corp/large"))).not.toContain("data_service");
    }
  });
});

describe("tool calls", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("run on the thread's machine, with the address and path from settings", async () => {
    await s.dispatch("th_ok", ALLOWED);
    expect(text(await s.call("th_ok", { method: "items", params: { code: "0012" } }))).toContain("COMPANY DATA");
    expect(s.hostCalls).toEqual([
      { method: "request", input: { baseUrl: "https://svc.example.com/api/tools/", path: "agent/items", query: { code: "0012" } }, hostId: "host_mac" },
    ]);
  });

  it("refuse an unknown method and bad parameters before any request", async () => {
    await s.dispatch("th_bad", ALLOWED);
    expect(text(await s.call("th_bad", { method: "https://evil.example.com" }))).toMatch(/no method/);
    expect(text(await s.call("th_bad", { method: "items" }))).toMatch(/needs the parameter/);
    expect(text(await s.call("th_bad", { method: "items", params: { code: "1", url: "x" } }))).toMatch(/no parameter/);
    expect(s.hostCalls).toHaveLength(0);
  });

  it("refuse when the thread switched to a model outside the list", async () => {
    await s.dispatch("th_switch", ALLOWED);
    await s.dispatch("th_switch", EXTERNAL);
    expect(text(await s.call("th_switch"))).toMatch(/not available to acp-opencode opencode\/free-model/);
    expect(text(await s.guide("th_switch"))).toMatch(/not available/);
    expect(s.hostCalls).toHaveLength(0);
  });

  it("refuse a thread whose model is unknown", async () => {
    expect(text(await s.call("th_unknown"))).toMatch(/not available/);
    await s.dispatch("th_null", { providerId: "acp-opencode", model: null });
    expect(text(await s.call("th_null"))).toMatch(/not available/);
    expect(s.hostCalls).toHaveLength(0);
  });

  it("the guide gives the rules and methods, or one method's reference", async () => {
    await s.dispatch("th_guide", ALLOWED);
    const all = text(await s.guide("th_guide"));
    expect(all).toContain("Be exact.");
    expect(all).toContain("items: List items");
    expect(all).not.toContain("Full reference of items");
    expect(text(await s.guide("th_guide", { method: "items" }))).toContain("Full reference of items");
    expect(text(await s.guide("th_guide", { method: "nope" }))).toMatch(/no method/);
  });
});

describe("failures an agent reads", () => {
  it.each([
    ["unauthorized", /Never ask for it in chat/],
    ["paused", /Never ask for it in chat/],
    ["noPassword", /Never ask for them in chat/],
    ["tls", /certificate/],
    ["unreachable", /VPN/],
    ["notFound", /configuration needs a fix/],
  ] as const)("%s", async (code, pattern) => {
    const s = await setup({}, { ok: false, code, status: null, detail: null });
    await s.dispatch("th", ALLOWED);
    const result = (await s.call("th")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(pattern);
  });

  it("a cut answer says it is incomplete", async () => {
    const s = await setup({}, { ok: true, text: "[1", truncated: true });
    await s.dispatch("th", ALLOWED);
    expect(text(await s.call("th"))).toContain("incomplete");
  });
});

describe("a configuration that cannot work", () => {
  it.each([
    ["no address", { baseUrl: "" }],
    ["plain http", { baseUrl: "http://svc.example.com" }],
    ["broken methods", { methods: "{" }],
    ["a path out of the base", { methods: '[{"name":"stages","path":"../x","summary":"S"}]' }],
    ["no check method", { checkMethod: "nope" }],
    ["a check method with a required parameter", { checkMethod: "items" }],
  ])("%s stops the tools and the sign-in check", async (_name, patch) => {
    const s = await setup(patch);
    await s.dispatch("th", ALLOWED);
    expect(text(await s.call("th"))).toMatch(/not configured/);
    expect(await s.harness.behavior.callRpc("checkSignIn", { hostId: "host_mac" })).toEqual({ ok: false, code: "notConfigured", status: null });
    expect(s.hostCalls).toHaveLength(0);
  });
});

describe("threads that hold the data", () => {
  it("cannot be continued by a model outside the list", async () => {
    const s = await setup();
    await s.dispatch("th_data", ALLOWED);
    await s.call("th_data");
    expect(await s.dispatch("th_data", EXTERNAL)).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_data", { providerId: "claude-code", model: "claude-opus-5-5" })).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_data", ALLOWED)).toEqual({ action: "proceed" });
  });

  it("the guide marks the thread too", async () => {
    const s = await setup();
    await s.dispatch("th_guide", ALLOWED);
    await s.guide("th_guide");
    expect(await s.dispatch("th_guide", EXTERNAL)).toMatchObject({ action: "reject" });
  });

  it("forks inherit the mark", async () => {
    const s = await setup();
    await s.dispatch("th_parent", ALLOWED);
    await s.call("th_parent");
    expect(await s.dispatch("th_fork", EXTERNAL, "th_parent")).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_fork", ALLOWED, "th_parent")).toEqual({ action: "proceed" });
    expect(await s.dispatch("th_fork", EXTERNAL)).toMatchObject({ action: "reject" });
  });

  it("forks of forks inherit it, at any depth, through threads that never ran", async () => {
    const s = await setup();
    await s.dispatch("a", ALLOWED);
    await s.call("a");
    s.parents.set("b", "a");
    s.parents.set("c", "b");
    expect(await s.dispatch("d", EXTERNAL, "c")).toMatchObject({ action: "reject" });
  });

  it("the mark survives deleting the parent while a fork lives", async () => {
    const s = await setup();
    await s.dispatch("p", ALLOWED);
    await s.call("p");
    await s.remove("p");
    expect(await s.dispatch("f", EXTERNAL, "p")).toMatchObject({ action: "reject" });
  });

  it("the mark survives deleting a thread in the middle of the line", async () => {
    const s = await setup();
    await s.dispatch("p", ALLOWED);
    await s.call("p");
    s.parents.set("m", "p");
    await s.remove("m");
    expect(await s.dispatch("f", EXTERNAL, "m")).toMatchObject({ action: "reject" });
  });

  it("a loop in the line does not hang, and a clean line stays clean after a delete", async () => {
    const s = await setup();
    s.parents.set("x", "y");
    s.parents.set("y", "x");
    expect(await s.dispatch("x", EXTERNAL, "y")).toEqual({ action: "proceed" });
    await s.remove("y");
    expect(await s.dispatch("z", EXTERNAL, "y")).toEqual({ action: "proceed" });
  });

  it("threads without the data may switch freely", async () => {
    const s = await setup();
    expect(await s.dispatch("th_clean", EXTERNAL)).toEqual({ action: "proceed" });
    expect(await s.dispatch("th_clean", ALLOWED)).toEqual({ action: "proceed" });
  });
});

describe("the panel", () => {
  it("never lets the panel choose the address", async () => {
    const s = await setup();
    await s.harness.behavior.callRpc("saveConnection", { hostId: "host_mac", user: "person", password: "pw" }).catch(() => undefined); // the stub answers no status
    expect(s.hostCalls[0]).toEqual({ method: "saveConnection", input: { baseUrl: "https://svc.example.com/api/tools/", user: "person", password: "pw" }, hostId: "host_mac" });
    await expect(s.harness.behavior.callRpc("saveConnection", { hostId: "host_mac", user: "person", baseUrl: "https://evil.example.com" } as never)).rejects.toThrow();
  });

  it("checks with the configured check method and returns no data", async () => {
    const s = await setup({}, { ok: true, code: null, status: null } as never);
    expect(await s.harness.behavior.callRpc("checkSignIn", { hostId: "host_mac" })).toEqual({ ok: true, code: null, status: null });
    expect(s.hostCalls[0]).toMatchObject({ method: "checkSignIn", input: { baseUrl: "https://svc.example.com/api/tools/", path: "agent/stages" } });
  });

  it("shows the name, the address and the rules, not the guide or the methods", async () => {
    const s = await setup();
    const config = await s.harness.behavior.callRpc("config", null);
    expect(config).toMatchObject({ name: "Sales data", address: "https://svc.example.com/api/tools/", problem: null, canCheck: true, rules: [{ provider: "acp-opencode", model: "corp/*" }] });
    expect(text(config)).not.toContain("Be exact");
    expect(text(config)).not.toContain("agent/items");
  });
});
