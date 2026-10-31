// The server's guard: who gets the mail tools, who may run them, which turns a
// thread holding mail may not take, and that no agent tool sends mail.
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import plugin, { rpcContract } from "../server";

const ALLOWED = { providerId: "acp-opencode", model: "corp/large" };
const EXTERNAL = { providerId: "acp-opencode", model: "opencode/free-model" };

async function setup(allowedModels = "acp-opencode corp/*") {
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  /** Fork sources bb answers with; ids starting with th_gone answer 404, like deleted threads. */
  const threads = new Map<string, string | null>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "exchange-mail",
    settings: { allowedModels, ewsUrl: "" },
    agentSkillIds: ["exchange-mail"],
    experimental_hostEntry: true,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId.startsWith("th_gone")) throw new Error("404 thread not found");
          return makeThreadResponse({ id: threadId, environmentId: "env_mac", providerId: "acp-opencode", sourceThreadId: threads.get(threadId) ?? null });
        },
      },
      environments: { get: async () => ({ id: "env_mac", hostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push({ method, input, hostId });
      if (method === "tool") return { text: "MAIL DATA", isError: false, draftId: (input as { tool: string }).tool === "draft" ? "d_000000000001" : null };
      if (method === "send") return { status: "sent", at: 1 };
      if (method === "list") return { messages: [], total: 0, more: false, unread: 0 };
      if (method === "draft") return null;
      return {};
    },
  });
  await plugin(bb);
  const dispatch = (threadId: string, execution: { providerId: string; model: string | null }, sourceThreadId: string | null = null) =>
    harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId, sourceThreadId }, requestedExecution: execution }));
  const configure = (providerId: string, model: string) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model } }));
  const tool = (name: string, params: unknown, threadId: string) => harness.behavior.callAgentTool(name, params, { threadId });
  const event = (name: "thread.created" | "thread.deleted", id: string, sourceThreadId: string | null = null) =>
    harness.emitThreadEvent(name, { thread: makeThreadResponse({ id, sourceThreadId }) });
  return { harness, hostCalls, dispatch, configure, tool, threads, event };
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

describe("threads holding mail", () => {
  const CLAUDE = { providerId: "claude-code", model: "claude-opus-5-5" };
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
    await s.dispatch("th_mail", ALLOWED);
    await s.tool("mail_read", { message: "m0123456789" }, "th_mail");
  });

  it("keeps a fork of a fork away from other models, even when the middle fork never ran", async () => {
    // th_mid was forked from th_mail and never dispatched; th_leaf is forked from th_mid.
    s.threads.set("th_mid", "th_mail");
    expect(await s.dispatch("th_leaf", CLAUDE, "th_mid")).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_leaf2", ALLOWED, "th_mid")).toEqual({ action: "proceed" });
  });

  it("keeps the mark when the thread with mail is deleted", async () => {
    await s.event("thread.deleted", "th_mail");
    expect(await s.dispatch("th_mail", CLAUDE)).toMatchObject({ action: "reject" });
    expect(await s.dispatch("th_fork", CLAUDE, "th_mail")).toMatchObject({ action: "reject" });
  });

  it("follows the chain through a deleted middle fork", async () => {
    // bb told the plugin about th_mid when it was created and when it was deleted; afterwards bb answers 404 for it.
    await s.event("thread.created", "th_gone_mid", "th_mail");
    await s.event("thread.deleted", "th_gone_mid", "th_mail");
    expect(await s.dispatch("th_leaf", CLAUDE, "th_gone_mid")).toMatchObject({ action: "reject" });
  });

  it("marks a fork when it is created, before its first turn", async () => {
    await s.event("thread.created", "th_fork", "th_mail");
    await s.event("thread.deleted", "th_mail");
    expect(await s.dispatch("th_fork", CLAUDE, "th_mail")).toMatchObject({ action: "reject" });
  });

  it("counts a fork chain it cannot follow as holding mail", async () => {
    expect(await s.dispatch("th_leaf", CLAUDE, "th_gone_unknown")).toMatchObject({ action: "reject" });
  });

  it("lets a fork of a thread without mail use any model", async () => {
    s.threads.set("th_clean_mid", "th_clean");
    expect(await s.dispatch("th_clean_leaf", CLAUDE, "th_clean_mid")).toEqual({ action: "proceed" });
  });

  it("does not loop on a cycle in fork sources", async () => {
    s.threads.set("th_a", "th_b");
    s.threads.set("th_b", "th_a");
    expect(await s.dispatch("th_c", CLAUDE, "th_a")).toMatchObject({ action: "reject" });
  });
});

describe("panel RPC", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("has no way to change the allow-list: it comes from the build's settings", async () => {
    expect(Object.keys(rpcContract)).not.toContain("savePolicy");
    await expect(s.harness.callRpc("savePolicy", { rules: [{ provider: "claude-code", model: "*" }] })).rejects.toThrow();
    expect(await s.harness.callRpc("policy", null)).toEqual({ rules: [{ provider: "acp-opencode", model: "corp/*" }], error: null });
  });

  it("refuses other plugins, for reads and for sending", async () => {
    const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "relay" } };
    await expect(s.harness.callRpc("list", { hostId: "host_mac" }, asPlugin)).rejects.toThrow(/does not answer other plugins/);
    await expect(s.harness.callRpc("read", { hostId: "host_mac", ref: "m0123456789" }, asPlugin)).rejects.toThrow(/does not answer other plugins/);
    await expect(s.harness.callRpc("sendDraft", { hostId: "host_mac", id: "d_000000000001", revision: "CK" }, asPlugin)).rejects.toThrow(/other plugins/);
    expect(s.hostCalls).toHaveLength(0);
  });

  it("cannot tell an unapproved model calling through the CLI from the panel: bb gives RPC no thread or model", async () => {
    // A thread running a model outside the list cannot use the tools...
    await s.dispatch("th_ext", EXTERNAL);
    expect(text(await s.tool("mail_list", {}, "th_ext"))).toMatch(/not available/);
    // ...but an RPC call reaches the handler as { kind: "client" }, exactly like the panel. The bb build must not ship such agents.
    await s.harness.callRpc("list", { hostId: "host_mac" });
    expect(s.hostCalls.map((c) => c.method)).toEqual(["list"]);
  });

  it("shows a thread's card only its own drafts", async () => {
    await s.harness.callRpc("draft", { threadId: "th_card", id: "d_000000000001" });
    expect(s.hostCalls[0]).toMatchObject({ method: "draft", input: { id: "d_000000000001", threadId: "th_card" }, hostId: "host_mac" });
    await s.harness.callRpc("sendDraft", { threadId: "th_card", id: "d_000000000001", revision: "CK" });
    expect(s.hostCalls[1]).toMatchObject({ method: "send", input: { id: "d_000000000001", revision: "CK", threadId: "th_card" } });
    // The panel names the machine, not a thread: no ownership filter.
    await s.harness.callRpc("draft", { hostId: "host_mac", id: "d_000000000001" });
    expect(s.hostCalls[2]!.input).toEqual({ id: "d_000000000001" });
  });
});
