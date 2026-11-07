// The server side of "Own agents": turning on takes a press in the system
// window, and the build's skills reach each agent by its audience.
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import type { ConfirmWindow, WindowOutcome, WindowText } from "../src/host/confirm-window.js";
import type { AgentBuild } from "../src/own-agents.js";

const BUILD: AgentBuild = {
  allowed: ["acp-opencode"],
  own: { providers: ["claude-code", "codex"], warning: "Your agent can read mail through bb commands.", delegate: { provider: "acp-opencode", model: "corp/big-model" } },
  skills: [
    { id: "tools", name: "tools", description: "How to use the build's tools.", audience: "allowed", body: "TOOLS BODY" },
    { id: "corp", name: "corp-agent", description: "Hand a step to the build's agent.", audience: "own", body: "CORP BODY" },
  ],
};

async function setup(answer: WindowOutcome, build: AgentBuild | null = BUILD) {
  const windows: WindowText[] = [];
  const confirmWindow: ConfirmWindow = {
    confirm: async (text) => {
      windows.push(text);
      return answer;
    },
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "fleet-kit", agentSkillIds: ["fleet-kit"], settings: { manifestUrl: "" } });
  if (build !== null) await bb.storage.kv.set("agentBuild", build);
  await plugin(bb, { confirmWindow });
  const configure = (providerId: string, threadId = `th_${providerId}`) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model: "m" }, thread: { id: threadId } }));
  const tool = (name: string, threadId: string) => harness.behavior.callAgentTool("build_skill", { name }, { threadId });
  const set = (on: boolean) => harness.callRpc("own_agents_set", { on, lang: "ru" }) as Promise<{ on: boolean; outcome: string }>;
  return { harness, windows, configure, tool, set, kv: bb.storage.kv };
}

const text = (value: unknown) => JSON.stringify(value);

describe("own agents on the server", () => {
  it("turns on only after a yes in the system window, which shows the build's warning", async () => {
    const s = await setup({ ok: true });
    expect(await s.set(true)).toEqual({ on: true, outcome: "on" });
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.message).toContain("Your agent can read mail through bb commands.");
    expect(s.windows[0]!.yes).toBe("Включить");
    expect(await s.kv.get("ownAgents")).toMatchObject({ on: true });
    // Already on: no second window.
    expect(await s.set(true)).toEqual({ on: true, outcome: "on" });
    expect(s.windows).toHaveLength(1);
    // Off takes no window.
    expect(await s.set(false)).toEqual({ on: false, outcome: "off" });
    expect(s.windows).toHaveLength(1);
    expect(await s.kv.get("ownAgents")).toMatchObject({ on: false });
  });

  for (const reason of ["cancelled", "timeout", "unavailable", "busy"] as const) {
    it(`stays off when the window answers ${reason}`, async () => {
      const s = await setup({ ok: false, reason });
      expect(await s.set(true)).toEqual({ on: false, outcome: reason });
      expect(await s.kv.get("ownAgents")).toBeUndefined();
      expect(text(await s.configure("claude-code"))).not.toContain("corp-agent");
    });
  }

  it("does nothing in a build without own agents", async () => {
    const s = await setup({ ok: true }, { ...BUILD, own: null });
    expect(await s.set(true)).toEqual({ on: false, outcome: "not-offered" });
    expect(s.windows).toHaveLength(0);
  });

  it("gives the delegation skill to own agents only once turned on, and the build's skill to the build's agent", async () => {
    const s = await setup({ ok: true });
    const before = await s.configure("claude-code");
    expect(before.tools).toEqual([]);
    expect(before.instructions).toBeNull();
    expect(before.skills).toEqual(["fleet-kit"]);
    expect(text(await s.tool("corp-agent", "th_claude-code"))).toContain("no build skills");

    await s.set(true);
    const after = await s.configure("claude-code");
    expect(after.tools.map((entry) => entry.name)).toEqual(["build_skill"]);
    expect(after.instructions).toContain("- corp-agent: Hand a step to the build's agent.");
    expect(after.instructions).not.toContain("tools");
    expect(text(await s.tool("corp-agent", "th_claude-code"))).toContain("CORP BODY");
    expect(text(await s.tool("tools", "th_claude-code"))).toContain("No build skill named tools");

    const opencode = await s.configure("acp-opencode");
    expect(opencode.instructions).toContain("- tools:");
    expect(opencode.instructions).not.toContain("corp-agent");
    expect(text(await s.tool("corp-agent", "th_acp-opencode"))).not.toContain("CORP BODY");
    expect(text(await s.tool("tools", "th_acp-opencode"))).toContain("TOOLS BODY");

    // An agent the build does not offer gets nothing.
    expect((await s.configure("cursor")).tools).toEqual([]);

    await s.set(false);
    expect((await s.configure("claude-code")).tools).toEqual([]);
    expect(text(await s.tool("corp-agent", "th_claude-code"))).not.toContain("CORP BODY");
  });

  it("shows the offer in the status", async () => {
    const s = await setup({ ok: true });
    const status = (await s.harness.callRpc("status", null)) as { ownAgents: Record<string, unknown> };
    expect(status.ownAgents).toMatchObject({ on: false, warning: BUILD.own!.warning, delegate: BUILD.own!.delegate });
    expect((status.ownAgents.providers as { id: string }[]).map((entry) => entry.id)).toEqual(["claude-code", "codex"]);
  });
});
