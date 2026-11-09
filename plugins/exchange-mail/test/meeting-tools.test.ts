// The meeting tools on the server: offered only to allowed models, refused to
// any other, every one of them a proposal for the host — no agent tool and no
// tool argument reaches confirmMeeting — and a thread's card sees only its own
// proposals.
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";

const ALLOWED = { providerId: "acp-opencode", model: "corp/large" };
const EXTERNAL = { providerId: "acp-opencode", model: "opencode/free-model" };
const MEETING_TOOLS = ["calendar_find_time", "calendar_propose_meeting", "calendar_propose_change", "calendar_propose_cancel", "calendar_propose_response"];

async function setup() {
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "exchange-mail",
    settings: { allowedModels: "acp-opencode corp/*", ewsUrl: "" },
    agentSkillIds: ["exchange-mail"],
    experimental_hostEntry: true,
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_mac", providerId: "acp-opencode" }) },
      environments: { get: async () => ({ id: "env_mac", hostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push({ method, input, hostId });
      if (method === "tool") {
        const tool = (input as { tool: string }).tool;
        return { text: "PROPOSED", isError: false, draftId: null, ...(tool === "meeting" ? { meetingId: "p_000000000001" } : {}) };
      }
      if (method === "confirmMeeting") return { status: "done", at: 1 };
      if (method === "meeting") return null;
      if (method === "proposeMeeting") {
        return {
          id: "p_000000000001", action: "cancel", source: "person", threadId: null, createdAt: 1, scope: "single", eventId: "e000000000001",
          before: { subject: "X", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z", location: null, required: [], optional: [], rooms: [] },
          after: null, body: null, organizer: null, response: null, note: null, notify: [], removed: [], revision: "R1",
        };
      }
      return {};
    },
  });
  await plugin(bb);
  const dispatch = (threadId: string, execution: { providerId: string; model: string | null }) =>
    harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId, sourceThreadId: null }, requestedExecution: execution }));
  const configure = (providerId: string, model: string) => harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId, model } }));
  const tool = (name: string, params: unknown, threadId: string) => harness.behavior.callAgentTool(name, params, { threadId });
  return { harness, hostCalls, dispatch, configure, tool };
}

const text = (value: unknown) => JSON.stringify(value);

describe("the meeting tools", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("are offered to allowed models only", async () => {
    const allowed = text(await s.configure("acp-opencode", "corp/large"));
    for (const name of MEETING_TOOLS) expect(allowed).toContain(name);
    const denied = text(await s.configure("claude-code", "claude-opus-5-5"));
    for (const name of MEETING_TOOLS) expect(denied).not.toContain(name);
  });

  it("refuse a thread running another model, before the host is asked", async () => {
    await s.dispatch("th_ext", EXTERNAL);
    for (const [name, params] of [
      ["calendar_propose_meeting", { subject: "X", start: "2026-11-10T10:00", end: "2026-11-10T11:00" }],
      ["calendar_find_time", { attendees: ["bob@example.test"] }],
      ["calendar_propose_cancel", { event: "e000000000001" }],
    ] as const) {
      expect(text(await s.tool(name, params, "th_ext"))).toMatch(/not available/);
    }
    expect(s.hostCalls).toHaveLength(0);
  });

  it("only propose: each goes to the host's tool as a proposal tied to the thread, and none confirms", async () => {
    await s.dispatch("th_ok", ALLOWED);
    await s.tool("calendar_propose_meeting", { subject: "Plan", start: "2026-11-10T10:00", end: "2026-11-10T11:00", attendees: ["bob@example.test"], rooms: ["room7@example.test"] }, "th_ok");
    await s.tool("calendar_propose_change", { event: "e000000000001", scope: "series", start: "2026-11-12T16:00", add_attendees: ["dave@example.test"], remove_attendees: ["carol@example.test"] }, "th_ok");
    await s.tool("calendar_propose_cancel", { event: "e000000000001", note: "Sorry" }, "th_ok");
    await s.tool("calendar_propose_response", { event: "e000000000002", response: "tentative", note: "Maybe" }, "th_ok");
    await s.tool("calendar_find_time", { attendees: ["bob@example.test"], from: "2026-11-10", minutes: 60 }, "th_ok");
    expect(s.hostCalls.map((c) => c.method)).toEqual(["tool", "tool", "tool", "tool", "tool"]);
    expect(s.hostCalls.map((c) => c.input)).toEqual([
      { tool: "meeting", threadId: "th_ok", proposal: { action: "create", subject: "Plan", start: "2026-11-10T10:00", end: "2026-11-10T11:00", required: ["bob@example.test"], rooms: ["room7@example.test"] } },
      { tool: "meeting", threadId: "th_ok", proposal: { action: "update", event: "e000000000001", scope: "series", start: "2026-11-12T16:00", add: ["dave@example.test"], remove: ["carol@example.test"] } },
      { tool: "meeting", threadId: "th_ok", proposal: { action: "cancel", event: "e000000000001", note: "Sorry" } },
      { tool: "meeting", threadId: "th_ok", proposal: { action: "respond", event: "e000000000002", response: "tentative", note: "Maybe" } },
      { tool: "findTime", attendees: ["bob@example.test"], from: "2026-11-10", minutes: 60 },
    ]);
    // A proposal announces itself to open cards.
    expect(s.harness.realtimeSignals).toContainEqual({ channel: "meetings-changed", payload: { id: "p_000000000001" } });
  });

  it("registers no tool that writes to the calendar or confirms", async () => {
    const names = Object.keys(s.harness.registrations.agentTools ?? {});
    expect(names.join(" ")).not.toMatch(/confirm|create_meeting|send|accept|decline/);
  });

  it("shows a thread's card only its own proposals, and confirms only the revision named", async () => {
    await s.harness.callRpc("meeting", { threadId: "th_card", id: "p_000000000001" });
    expect(s.hostCalls[0]).toMatchObject({ method: "meeting", input: { id: "p_000000000001", threadId: "th_card" }, hostId: "host_mac" });
    await s.harness.callRpc("confirmMeeting", { threadId: "th_card", id: "p_000000000001", revision: "R1", lang: "ru" });
    expect(s.hostCalls[1]).toMatchObject({ method: "confirmMeeting", input: { id: "p_000000000001", revision: "R1", lang: "ru", threadId: "th_card" } });
    // The panel prepares proposals as the person, on the machine it names.
    await s.harness.callRpc("proposeMeeting", { hostId: "host_mac", proposal: { action: "cancel", event: "e000000000001" } });
    expect(s.hostCalls[2]).toMatchObject({ method: "proposeMeeting", input: { source: "person", threadId: null, proposal: { action: "cancel", event: "e000000000001" } } });
  });

  it("refuse other plugins", async () => {
    const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "relay" } };
    await expect(s.harness.callRpc("confirmMeeting", { hostId: "host_mac", id: "p_000000000001", revision: "R" }, asPlugin)).rejects.toThrow(/other plugins/);
    await expect(s.harness.callRpc("proposeMeeting", { hostId: "host_mac", proposal: { action: "cancel", event: "e000000000001" } }, asPlugin)).rejects.toThrow(/other plugins/);
    expect(s.hostCalls).toHaveLength(0);
  });
});
