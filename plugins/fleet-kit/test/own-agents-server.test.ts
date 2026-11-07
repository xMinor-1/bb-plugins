// The server side of "Own agents": turning on takes a press in the system
// window, and the build's skills reach each agent by its audience.
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import type { ConfirmWindow, WindowOutcome, WindowText } from "../src/host/confirm-window.js";
import { consentKey, type AgentBuild } from "../src/own-agents.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, sampleManifest } from "./fixtures.js";
import { OWN_AGENTS_PAUSE_MS } from "../server";

const BUILD: AgentBuild = {
  allowed: ["acp-opencode"],
  own: { providers: ["claude-code", "codex"], warning: "Your agent can read mail through bb commands.", delegate: { provider: "acp-opencode", model: "corp/big-model" } },
  skills: [
    { id: "tools", name: "tools", description: "How to use the build's tools.", audience: "allowed", body: "TOOLS BODY" },
    { id: "corp", name: "corp-agent", description: "Hand a step to the build's agent.", audience: "own", body: "CORP BODY" },
  ],
};

interface SetupOptions {
  choice?: unknown;
  rawBuild?: unknown;
  failGet?: boolean;
  manifestUrl?: string;
}

async function setup(answer: WindowOutcome, build: AgentBuild | null = BUILD, extra: SetupOptions = {}) {
  const windows: WindowText[] = [];
  const clock = { now: Date.parse("2026-11-07T10:00:00.000Z") };
  const confirmWindow: ConfirmWindow = {
    confirm: async (text) => {
      windows.push(text);
      return answer;
    },
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "fleet-kit", agentSkillIds: ["fleet-kit"], settings: { manifestUrl: extra.manifestUrl ?? "", allowDevSources: true } });
  if (build !== null) await bb.storage.kv.set("agentBuild", build);
  if (extra.rawBuild !== undefined) await bb.storage.kv.set("agentBuild", extra.rawBuild);
  if (extra.choice !== undefined) await bb.storage.kv.set("ownAgents", extra.choice);
  const realGet = bb.storage.kv.get.bind(bb.storage.kv);
  if (extra.failGet) (bb.storage.kv as { get: unknown }).get = async () => { throw new Error("disk I/O error"); };
  await plugin(bb, { confirmWindow, now: () => clock.now });
  if (extra.failGet) (bb.storage.kv as { get: unknown }).get = realGet;
  const configure = (providerId: string, threadId = `th_${providerId}`) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model: "m" }, thread: { id: threadId } }));
  const tool = (name: string, threadId: string) => harness.behavior.callAgentTool("build_skill", { name }, { threadId });
  const set = (on: boolean) => harness.callRpc("own_agents_set", { on, lang: "ru" }) as Promise<{ on: boolean; outcome: string }>;
  const status = async () => ((await harness.callRpc("status", null)) as { ownAgents: Record<string, any> | null }).ownAgents;
  return { harness, windows, configure, tool, set, kv: bb.storage.kv, clock, status };
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

  it("needs a new window when the warning changed or an agent was added", async () => {
    const yes = { on: true, at: "2026-11-07T09:00:00.000Z", key: consentKey(BUILD.own!) };
    const same = await setup({ ok: true }, BUILD, { choice: yes });
    expect((await same.status())!.on).toBe(true);
    expect(text(await same.configure("claude-code"))).toContain("corp-agent");

    const changed = await setup({ ok: true }, { ...BUILD, own: { ...BUILD.own!, warning: `${BUILD.own!.warning} And more.` } }, { choice: yes });
    expect((await changed.status())!.on).toBe(false);
    expect(text(await changed.configure("claude-code"))).not.toContain("corp-agent");
    expect(await changed.set(true)).toEqual({ on: true, outcome: "on" });
    expect(changed.windows).toHaveLength(1);
    expect(changed.windows[0]!.message).toContain("And more.");

    const added = await setup({ ok: true }, { ...BUILD, own: { ...BUILD.own!, providers: ["claude-code", "codex", "cursor"] } }, { choice: yes });
    expect((await added.status())!.on).toBe(false);
    expect(await added.set(true)).toEqual({ on: true, outcome: "on" });
    expect(added.windows).toHaveLength(1);
  });

  it("forgets the yes when a sync reads a build without own agents, so offering them again takes a window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fk-own-"));
    const path = join(dir, "manifest.json");
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.agents = { allowed: ["acp-opencode"] };
    await writeFile(path, JSON.stringify(manifest));
    const yes = { on: true, at: "2026-11-07T09:00:00.000Z", key: consentKey(BUILD.own!) };
    const s = await setup({ ok: true }, BUILD, { choice: yes, manifestUrl: path });
    expect((await s.status())!.on).toBe(true);
    await s.harness.runCli(["sync"]);
    expect(await s.status()).toBeNull();
    expect(await s.kv.get("ownAgents")).toBeNull();
    // The same block comes back: the yes is gone.
    await s.kv.set("agentBuild", BUILD);
    const again = await setup({ ok: true }, BUILD, { choice: (await s.kv.get("ownAgents")) ?? undefined });
    expect((await again.status())!.on).toBe(false);
    expect(await again.set(true)).toEqual({ on: true, outcome: "on" });
    expect(again.windows).toHaveLength(1);
  });

  it("waits 10 minutes after a cancelled or unanswered window and counts the refusals", async () => {
    const s = await setup({ ok: false, reason: "cancelled" });
    const set = () => s.set(true);
    expect(await set()).toEqual({ on: false, outcome: "cancelled" });
    expect((await s.status())!.refusals).toBe(1);
    expect((await s.status())!.retryAt).toBe("2026-11-07T10:10:00.000Z");
    // Within the pause no window opens at all.
    s.clock.now += OWN_AGENTS_PAUSE_MS - 1000;
    expect(await set()).toEqual({ on: false, outcome: "paused" });
    expect(s.windows).toHaveLength(1);
    s.clock.now += 2000;
    expect((await s.status())!.retryAt).toBeNull();
    expect(await set()).toEqual({ on: false, outcome: "cancelled" });
    expect(s.windows).toHaveLength(2);
    expect((await s.status())!.refusals).toBe(2);
  });

  it("counts an unanswered window and not a busy or unavailable one", async () => {
    const timeout = await setup({ ok: false, reason: "timeout" });
    await timeout.set(true);
    expect((await timeout.status())!.refusals).toBe(1);
    for (const reason of ["busy", "unavailable"] as const) {
      const s = await setup({ ok: false, reason });
      await s.set(true);
      expect((await s.status())!.refusals).toBe(0);
      expect(await s.set(true)).toEqual({ on: false, outcome: reason });
    }
  });

  it("changes nothing when the choice cannot be saved", async () => {
    const s = await setup({ ok: true });
    const realSet = s.kv.set.bind(s.kv);
    (s.kv as { set: unknown }).set = async (key: string, value: unknown) => {
      if (key === "ownAgents") throw new Error("disk full");
      return realSet(key, value);
    };
    await expect(s.set(true)).rejects.toThrow(/could not save the choice, so nothing changed: disk full/);
    expect((await s.status())!.on).toBe(false);
    expect(text(await s.configure("claude-code"))).not.toContain("corp-agent");
    (s.kv as { set: unknown }).set = realSet;
    await s.set(true);
    (s.kv as { set: unknown }).set = async (key: string, value: unknown) => {
      if (key === "ownAgents") throw new Error("disk full");
      return realSet(key, value);
    };
    await expect(s.set(false)).rejects.toThrow(/nothing changed/);
    expect((await s.status())!.on).toBe(true);
  });

  it("starts with own agents off when storage cannot be read or holds a broken block", async () => {
    const yes = { on: true, at: "2026-11-07T09:00:00.000Z", key: consentKey(BUILD.own!) };
    const unreadable = await setup({ ok: true }, BUILD, { choice: yes, failGet: true });
    expect(text(await unreadable.configure("claude-code"))).not.toContain("corp-agent");
    expect(await unreadable.status()).toBeNull();

    const broken = await setup({ ok: true }, null, { choice: yes, rawBuild: { allowed: ["acp-opencode"], own: { warning: "w" }, skills: BUILD.skills } });
    expect(await broken.status()).toBeNull();
    expect(text(await broken.configure("claude-code"))).not.toContain("corp-agent");
    expect(await broken.set(true)).toEqual({ on: false, outcome: "not-offered" });

    const choiceBroken = await setup({ ok: true }, BUILD, { choice: { on: "yes" } });
    expect((await choiceBroken.status())!.on).toBe(false);
  });

  it("serves the saved branding to the page, and nothing before a build was read", async () => {
    const s = await setup({ ok: true });
    const get = async () => (await s.harness.behavior.fetchHttp("GET", "/branding")).json();
    expect(await get()).toEqual({ appName: "", logoSvg: "" });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    await s.kv.set("branding", { appName: "Example", logoSvg: svg });
    expect(await get()).toEqual({ appName: "Example", logoSvg: svg });
    await s.kv.set("branding", { appName: "Example", logoSvg: "<script>1</script>" });
    expect(await get()).toEqual({ appName: "Example", logoSvg: "" });
  });

  it("shows the offer in the status", async () => {
    const s = await setup({ ok: true });
    const status = (await s.harness.callRpc("status", null)) as { ownAgents: Record<string, unknown> };
    expect(status.ownAgents).toMatchObject({ on: false, warning: BUILD.own!.warning, delegate: BUILD.own!.delegate });
    expect((status.ownAgents.providers as { id: string }[]).map((entry) => entry.id)).toEqual(["claude-code", "codex"]);
  });
});
