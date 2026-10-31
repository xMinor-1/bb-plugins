// The server's guard: who gets the mail tools, who may run them, which turns a
// thread holding mail may not take, and that no agent tool sends mail.
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

async function setup(allowedModels = "acp-opencode corp/*") {
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "exchange-mail",
    settings: { allowedModels, ewsUrl: "" },
    agentSkillIds: ["exchange-mail"],
    experimental_hostEntry: true,
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_mac", providerId: "acp-opencode" }) },
      environments: { get: async () => ({ id: "env_mac", hostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push({ method, input, hostId });
      if (method === "tool") return { text: "MAIL DATA", isError: false, draftId: (input as { tool: string }).tool === "draft" ? "d_000000000001" : null };
      if (method === "send") return { status: "sent", at: 1 };
      return {};
    },
  });
  await plugin(bb);
  const dispatch = (threadId: string, execution: { providerId: string; model: string | null }, sourceThreadId: string | null = null) =>
    harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId, sourceThreadId }, requestedExecution: execution }));
  const configure = (providerId: string, model: string) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model } }));
  const tool = (name: string, params: unknown, threadId: string) => harness.behavior.callAgentTool(name, params, { threadId });
  return { harness, hostCalls, dispatch, configure, tool };
}

const text = (result: unknown) => JSON.stringify(result);

describe("agent configuration", () => {
  it("offers the mail tools and skill only to allowed models", async () => {
    const { configure } = await setup();
    const allowed = await configure("acp-opencode", "corp/large");
    for (const name of ["mail_list", "mail_search", "mail_read", "mail_draft", "exchange-mail"]) expect(text(allowed)).toContain(name);
    for (const [provider, model] of [
      ["acp-opencode", "opencode/free-model"],
      ["claude-code", "claude-opus-5-5"],
      ["codex", "gpt-5"],
    ] as const) {
      const denied = await configure(provider, model);
      expect(text(denied), `${provider} ${model}`).not.toContain("mail_");
      expect(text(denied)).not.toContain("exchange-mail");
    }
  });

  it("offers nothing while no agent is allowed", async () => {
    const { configure } = await setup("");
    expect(text(await configure("acp-opencode", "corp/large"))).not.toContain("mail_");
  });

  it("registers no tool that sends mail", async () => {
    const { harness } = await setup();
    const names = Object.keys(harness.registrations.agentTools ?? {}).concat(
      ((harness.registrations as unknown as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name),
    );
    const all = JSON.stringify(harness.registrations).toLowerCase();
    expect(all).toContain("mail_draft");
    expect(names.join(" ")).not.toMatch(/send/);
    expect(all).not.toMatch(/"mail_send"|"send_mail"|"mail_reply_send"/);
  });
});

describe("tool calls", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("runs on the thread's machine when the running model is allowed", async () => {
    expect(await s.dispatch("th_ok", ALLOWED)).toEqual({ action: "proceed" });
    const result = await s.tool("mail_list", { unread_only: true }, "th_ok");
    expect(text(result)).toContain("MAIL DATA");
    expect(s.hostCalls).toEqual([{ method: "tool", input: { tool: "list", unreadOnly: true }, hostId: "host_mac" }]);
  });

  it("passes the thread to drafts so a draft stays tied to it", async () => {
    await s.dispatch("th_ok", ALLOWED);
    await s.tool("mail_draft", { reply_to: "m0123456789", body: "Hello" }, "th_ok");
    expect(s.hostCalls[0]).toMatchObject({ method: "tool", input: { tool: "draft", threadId: "th_ok", replyTo: "m0123456789", body: "Hello" } });
  });

  it("refuses when the thread switched to a model outside the list", async () => {
    await s.dispatch("th_switch", ALLOWED);
    await s.dispatch("th_switch", EXTERNAL);
    const result = await s.tool("mail_read", { message: "m0123456789" }, "th_switch");
    expect(text(result)).toMatch(/not available to acp-opencode opencode\/free-model/);
    expect(s.hostCalls).toHaveLength(0);
  });

  it("refuses a thread that never dispatched through bb", async () => {
    const result = await s.tool("mail_list", {}, "th_unknown");
    expect(text(result)).toMatch(/not available to this agent/);
    expect(s.hostCalls).toHaveLength(0);
  });

  it("keeps a thread holding mail away from other models, and its forks too", async () => {
    await s.dispatch("th_mail", ALLOWED);
    await s.tool("mail_list", {}, "th_mail");
    expect(await s.dispatch("th_mail", EXTERNAL)).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_mail", { providerId: "claude-code", model: "claude-opus-5-5" })).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_fork", { providerId: "claude-code", model: "claude-opus-5-5" }, "th_mail")).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_mail", ALLOWED)).toEqual({ action: "proceed" });
    // A thread without mail may use any model.
    expect(await s.dispatch("th_clean", { providerId: "claude-code", model: "claude-opus-5-5" })).toEqual({ action: "proceed" });
  });

  it("fails closed when the rule list is broken", async () => {
    const broken = await setup("acp-opencode");
    await broken.dispatch("th", ALLOWED);
    expect(text(await broken.tool("mail_list", {}, "th"))).toMatch(/not available/);
    expect(text(await broken.configure("acp-opencode", "corp/large"))).not.toContain("mail_");
  });
});
