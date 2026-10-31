// The server entry: who gets the agent tools, what they say, setupStatus for a
// build's first-run checklist, and that other plugins cannot drive the panel.
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { ServerView, Status } from "../contract";
import plugin, { describeStatus, setupAnswer, summarize } from "../server";

const server = (name: string, patch: Partial<ServerView> = {}): ServerView => ({
  name,
  url: `https://mcp.example.com/u/1/${name}/mcp`,
  enabled: true,
  timeoutSec: null,
  headers: ["Authorization"],
  secretHeaders: ["Authorization"],
  conflict: false,
  addedAt: 1,
  health: { status: "ok", since: Date.UTC(2026, 9, 31, 10, 0), checkedAt: Date.UTC(2026, 9, 31, 10, 5), detail: null, tools: 7 },
  ...patch,
});

const STATUS: Status = {
  servers: [server("wiki_ab12"), server("tracker_cd34", { enabled: false, health: { status: "unknown", since: null, checkedAt: null, detail: null, tools: null } })],
  configFile: "/home/u/.config/opencode/opencode.json",
  configError: null,
  store: "file (/home/u/.local/share/bb-mcp-catalog/secrets)",
};

async function setup(allowedModels = "acp-opencode corp/*") {
  const hostCalls: { method: string; input: Record<string, unknown>; hostId: string }[] = [];
  let status: Status = structuredClone(STATUS);
  const { bb, harness } = createFakePluginHost({
    pluginId: "mcp-catalog",
    settings: { allowedModels, catalogUrl: "", platformUrl: "", callTimeoutSeconds: 30, checkIntervalMinutes: 10, opencodeConfigDir: "" },
    experimental_hostEntry: true,
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_1", providerId: "acp-opencode" }) },
      environments: { get: async () => ({ id: "env_1", hostId: "host_1" }) },
      system: { config: async () => ({ primaryHostId: "host_1" }) },
      hosts: { list: async () => [] },
    } as never,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push({ method, input: input as Record<string, unknown>, hostId });
      if (method === "setEnabled") {
        const { name, enabled } = input as { name: string; enabled: boolean };
        status = { ...status, servers: status.servers.map((item) => (item.name === name ? { ...item, enabled } : item)) };
      }
      return status;
    },
  });
  await plugin(bb);
  const dispatch = (threadId: string, providerId: string, model: string | null) =>
    harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId }, requestedExecution: { providerId, model } }));
  const configure = (providerId: string, model: string) => harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model } }));
  const tool = (name: string, params: unknown, threadId: string) => harness.behavior.callAgentTool(name, params, { threadId });
  return { harness, hostCalls, dispatch, configure, tool };
}

const text = (value: unknown) => JSON.stringify(value);

describe("agent tools", () => {
  it("are offered only to the allowed models", async () => {
    const { configure } = await setup();
    expect(text(await configure("acp-opencode", "corp/large"))).toContain("mcp_enable");
    for (const [provider, model] of [
      ["acp-opencode", "opencode/free"],
      ["claude-code", "claude-opus-5-5"],
    ] as const) {
      expect(text(await configure(provider, model)), `${provider} ${model}`).not.toContain("mcp_");
    }
    const none = await setup("");
    expect(text(await none.configure("acp-opencode", "corp/large"))).not.toContain("mcp_");
  });

  it("re-check the model the thread runs now", async () => {
    const { dispatch, tool, hostCalls } = await setup();
    await dispatch("th_1", "acp-opencode", "opencode/free");
    const denied = await tool("mcp_servers", {}, "th_1");
    expect(text(denied)).toContain("not available");
    expect(hostCalls).toEqual([]);

    await dispatch("th_1", "acp-opencode", "corp/large");
    const listed = await tool("mcp_servers", {}, "th_1");
    expect(text(listed)).toContain("wiki_ab12");
    expect(text(listed)).toContain("works since 2026-10-31 10:00 UTC");
    expect(hostCalls.map((call) => [call.method, call.hostId])).toEqual([["status", "host_1"]]);
  });

  it("switch a server by a unique part of its name and say it shows in a new thread", async () => {
    const { dispatch, tool, hostCalls } = await setup();
    await dispatch("th_2", "acp-opencode", "corp/large");
    const result = await tool("mcp_enable", { name: "tracker" }, "th_2");
    expect(text(result)).toContain("Turned on tracker_cd34");
    expect(text(result)).toContain("NEW thread");
    const enable = hostCalls.find((call) => call.method === "setEnabled")!;
    expect(enable.input).toMatchObject({ name: "tracker_cd34", enabled: true, config: { opencodeConfigDir: "", timeoutSec: 30 } });
    expect(hostCalls.some((call) => call.method === "check")).toBe(true);

    const unknown = await tool("mcp_disable", { name: "nothing" }, "th_2");
    expect(text(unknown)).toContain("No MCP server called");
  });

  it("never return tokens or header values", async () => {
    expect(describeStatus(STATUS)).not.toMatch(/Bearer|Authorization/);
  });
});

describe("panel signals", () => {
  it("announce a change once, not every read (a panel re-reads on the signal)", async () => {
    const { harness } = await setup();
    const published = () => harness.realtimeSignals.length;
    await harness.behavior.callRpc("status", { hostId: "host_1" });
    const first = published();
    await harness.behavior.callRpc("status", { hostId: "host_1" });
    await harness.behavior.callRpc("status", { hostId: "host_1" });
    expect(published()).toBe(first);
    await harness.behavior.callRpc("setEnabled", { hostId: "host_1", name: "tracker_cd34", enabled: true });
    expect(published()).toBe(first + 1);
  });
});

describe("setupStatus", () => {
  it("answers from the last status heard, in the asked language", async () => {
    expect(setupAnswer(undefined, "en")).toMatchObject({ state: "todo", path: "/plugins/mcp-catalog/mcp" });
    expect(setupAnswer(summarize(STATUS, 1), "ru")).toEqual({ state: "done", summary: "Работает MCP-серверов: 1", path: "/plugins/mcp-catalog/mcp" });
    const failing: Status = { ...STATUS, servers: [server("a", { health: { status: "unauthorized", since: 1, checkedAt: 1, detail: "HTTP 401", tools: null } })] };
    expect(setupAnswer(summarize(failing, 1), "en")).toMatchObject({ state: "problem" });
    const off: Status = { ...STATUS, servers: [server("a", { enabled: false })] };
    expect(setupAnswer(summarize(off, 1), "en")).toMatchObject({ state: "problem" });
  });

  it("is open to other plugins while the panel's methods are not", async () => {
    const { harness } = await setup();
    const fromFleetKit = { experimental_caller: { kind: "plugin", pluginId: "fleet-kit" } };
    const before = await harness.behavior.callRpc("setupStatus", { lang: "en" }, fromFleetKit as never);
    expect(before).toMatchObject({ state: "todo" });
    await harness.behavior.callRpc("status", { hostId: "host_1" });
    expect(await harness.behavior.callRpc("setupStatus", {}, fromFleetKit as never)).toMatchObject({ state: "done" });
    await expect(harness.behavior.callRpc("status", { hostId: "host_1" }, fromFleetKit as never)).rejects.toThrow(/only its own panel|forbidden/);
  });
});
