// The server's guard: who gets the tools, who may run them, and which turns a
// thread holding Qlik data may not take.
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";

const ALLOWED = { providerId: "acp-opencode", model: "corp/large" };
const EXTERNAL = { providerId: "acp-opencode", model: "opencode/free-model" };

async function setup() {
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "qlik-sense",
    settings: { allowedModels: "acp-opencode corp/*" },
    agentSkillIds: ["qlik-sense"],
    experimental_hostEntry: true,
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_mac", providerId: "acp-opencode" }) },
      environments: { get: async () => ({ id: "env_mac", hostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push({ method, input, hostId });
      return { text: "QLIK DATA", isError: false };
    },
  });
  await plugin(bb);
  const dispatch = (threadId: string, execution: { providerId: string; model: string | null }, sourceThreadId: string | null = null) =>
    harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({ thread: { id: threadId, sourceThreadId }, requestedExecution: execution }),
    );
  const configure = (providerId: string, model: string) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model } }));
  const tool = (threadId: string) => harness.behavior.callAgentTool("qlik_reports", {}, { threadId });
  return { harness, hostCalls, dispatch, configure, tool };
}

const text = (result: unknown) => JSON.stringify(result);

describe("agent configuration", () => {
  it("offers tools and the skill only to allowed models", async () => {
    const { configure } = await setup();
    const allowed = await configure("acp-opencode", "corp/large");
    expect(text(allowed)).toContain("qlik_get_data");
    expect(text(allowed)).toContain("qlik-sense");
    for (const [provider, model] of [
      ["acp-opencode", "opencode/free-model"],
      ["claude-code", "claude-opus-5-5"],
      ["codex", "gpt-5"],
    ] as const) {
      const denied = await configure(provider, model);
      expect(text(denied), `${provider} ${model}`).not.toContain("qlik_");
      expect(text(denied)).not.toContain("qlik-sense");
    }
  });
});

describe("tool calls", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("runs on the thread's machine when the running model is allowed", async () => {
    expect(await s.dispatch("th_ok", ALLOWED)).toEqual({ action: "proceed" });
    const result = await s.tool("th_ok");
    expect(text(result)).toContain("QLIK DATA");
    expect(s.hostCalls).toEqual([{ method: "tool", input: { tool: "reports" }, hostId: "host_mac" }]);
  });

  it("refuses when the thread switched to a model outside the list", async () => {
    await s.dispatch("th_switch", ALLOWED);
    await s.dispatch("th_switch", EXTERNAL);
    const result = await s.tool("th_switch");
    expect(text(result)).toMatch(/not available to acp-opencode opencode\/free-model/);
    expect(s.hostCalls).toHaveLength(0);
  });

  it("refuses a thread whose model is unknown", async () => {
    expect(text(await s.tool("th_unknown"))).toMatch(/not available/);
    await s.dispatch("th_null", { providerId: "acp-opencode", model: null });
    expect(text(await s.tool("th_null"))).toMatch(/not available/);
    expect(s.hostCalls).toHaveLength(0);
  });
});

describe("threads that hold Qlik data", () => {
  it("cannot be continued by a model outside the list", async () => {
    const s = await setup();
    await s.dispatch("th_data", ALLOWED);
    await s.tool("th_data");
    expect(await s.dispatch("th_data", EXTERNAL)).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_data", { providerId: "claude-code", model: "claude-opus-5-5" })).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_data", ALLOWED)).toEqual({ action: "proceed" });
  });

  it("forks inherit the mark", async () => {
    const s = await setup();
    await s.dispatch("th_parent", ALLOWED);
    await s.tool("th_parent");
    expect(await s.dispatch("th_fork", EXTERNAL, "th_parent")).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_fork", ALLOWED, "th_parent")).toEqual({ action: "proceed" });
    expect(await s.dispatch("th_fork", EXTERNAL)).toMatchObject({ action: "reject" });
  });

  it("threads without Qlik data may switch freely", async () => {
    const s = await setup();
    expect(await s.dispatch("th_clean", EXTERNAL)).toEqual({ action: "proceed" });
    expect(await s.dispatch("th_clean", ALLOWED)).toEqual({ action: "proceed" });
  });
});

describe("policy editing", () => {
  it("saves rules from the panel and applies them at once", async () => {
    const s = await setup();
    const saved = await s.harness.behavior.callRpc("savePolicy", { rules: [{ provider: "claude-code", model: "claude-opus-5-5" }] });
    expect(saved).toMatchObject({ rules: [{ provider: "claude-code", model: "claude-opus-5-5" }], error: null });
    expect(text(await s.configure("claude-code", "claude-opus-5-5"))).toContain("qlik_reports");
    expect(text(await s.configure("acp-opencode", "corp/large"))).not.toContain("qlik_reports");
  });

  it("an empty list gives nobody the tools", async () => {
    const s = await setup();
    await s.harness.behavior.callRpc("savePolicy", { rules: [] });
    expect(text(await s.configure("acp-opencode", "corp/large"))).not.toContain("qlik_");
  });
});
