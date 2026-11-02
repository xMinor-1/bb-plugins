// The onboarding step another plugin reads: its states and which machine it asks.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { Status } from "../contract";
import plugin from "../server";
import { SETUP_PATH, setupFromStatus } from "../src/shared/setup";

const base: Status = {
  platform: "darwin",
  browser: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  open: false,
  signedIn: true,
  directory: { at: 1, chats: 12, people: 3 },
  lastError: null,
};
const status = (patch: Partial<Status>): Status => ({ ...base, ...patch });
const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "fleet-kit" } };

describe("setupFromStatus", () => {
  it.each([
    ["no browser", { browser: null }, "problem", "No Chromium-based browser on this machine: install Google Chrome or Microsoft Edge"],
    ["never signed in", { signedIn: null, directory: null }, "todo", "Sign in to the messenger"],
    ["session ended", { signedIn: false }, "todo", "The messenger asks to sign in again"],
    ["signed in, no directory yet", { directory: null }, "done", "Signed in to the messenger"],
    ["a directory from an earlier sign-in", { signedIn: null }, "done", "Signed in to the messenger"],
    ["signed in", {}, "done", "Signed in to the messenger"],
  ] as const)("%s", (_name, patch, state, summary) => {
    expect(setupFromStatus(status(patch as Partial<Status>))).toEqual({ state, summary, path: SETUP_PATH });
  });

  it("speaks the language it is asked in", () => {
    expect(setupFromStatus(status({ signedIn: null, directory: null }), "ru").summary).toBe("Войдите в мессенджер");
    expect(setupFromStatus(status({}), "ru").summary).toBe("Вход в мессенджер выполнен");
  });
});

async function setup(options: { hosts?: string[]; offline?: string[]; primary?: string | null; lastHost?: string; hostAnswer?: () => Status; webClientUrl?: string } = {}) {
  const asked: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "express-messenger",
    settings: { webClientUrl: options.webClientUrl ?? "https://express.example.com/" },
    agentSkillIds: ["express-messenger"],
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => (options.hosts ?? ["host_mac"]).map((id) => ({ id, name: id, status: options.offline?.includes(id) ? "disconnected" : "connected", lifecycle: { phase: "ready" } })),
      },
      system: { config: async () => ({ primaryHostId: options.primary === undefined ? "host_mac" : options.primary }) },
    } as never,
    experimental_callHostRpc: async ({ method, hostId }) => {
      if (method === "forget") return { ok: true, message: "Removed." };
      if (method !== "status") throw new Error(`unexpected ${method}`);
      asked.push(hostId);
      if (!options.hostAnswer) throw new Error("state file is broken");
      return options.hostAnswer();
    },
  });
  await plugin(bb);
  if (options.lastHost) await bb.storage.kv.set("ui:lastHost", options.lastHost);
  return { harness, asked };
}

describe("setupStatus RPC", () => {
  it("answers another plugin from bb's own machine", async () => {
    const { harness, asked } = await setup({ hostAnswer: () => status({ signedIn: null, directory: null }) });
    expect(await harness.callRpc("setupStatus", { lang: "ru" }, asPlugin)).toEqual({ state: "todo", summary: "Войдите в мессенджер", path: SETUP_PATH });
    expect(asked).toEqual(["host_mac"]);
  });

  it("asks the machine the panel used last, the one named, or bb's machine when the last one is gone", async () => {
    const { harness, asked } = await setup({ hosts: ["host_mac", "host_win"], lastHost: "host_win", hostAnswer: () => status({}) });
    expect(await harness.callRpc("setupStatus", {}, asPlugin)).toMatchObject({ state: "done" });
    await harness.callRpc("setupStatus", { hostId: "host_mac" }, asPlugin);
    expect(asked).toEqual(["host_win", "host_mac"]);
    const gone = await setup({ lastHost: "host_gone", hostAnswer: () => status({}) });
    await gone.harness.callRpc("setupStatus", {}, asPlugin);
    expect(gone.asked).toEqual(["host_mac"]);
  });

  it("tells an unreachable machine from one that cannot read its state", async () => {
    const offline = await setup({ offline: ["host_mac"], hostAnswer: () => status({}) });
    expect(await offline.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "The machine is not reachable", path: SETUP_PATH });
    expect(offline.asked).toEqual([]);
    const broken = await setup();
    expect(await broken.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "The plugin could not read its state on that machine", path: SETUP_PATH });
  });

  it("asks the host once for a few seconds, and again after a change on the panel", async () => {
    const { harness, asked } = await setup({ hostAnswer: () => status({}) });
    await harness.callRpc("setupStatus", {}, asPlugin);
    await harness.callRpc("setupStatus", { lang: "ru" }, asPlugin);
    expect(asked).toEqual(["host_mac"]);
    await harness.callRpc("forget", { hostId: "host_mac" });
    await harness.callRpc("setupStatus", {}, asPlugin);
    expect(asked).toEqual(["host_mac", "host_mac"]);
  });

  it("keeps the panel's methods closed to other plugins", async () => {
    const { harness } = await setup({ hostAnswer: () => status({}) });
    for (const [method, input] of [["overview", null], ["status", { hostId: "host_mac" }], ["rules", null], ["findChats", { hostId: "host_mac", query: "team" }], ["forget", { hostId: "host_mac" }]] as const) {
      await expect(harness.callRpc(method, input, asPlugin), method).rejects.toThrow(/does not answer other plugins/);
    }
  });

  it("reports a bb without machines, and a build without an address, as problems", async () => {
    const none = await setup({ hosts: [], primary: null });
    expect(await none.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "No machine is connected to bb", path: SETUP_PATH });
    const noAddress = await setup({ webClientUrl: "", hostAnswer: () => status({}) });
    expect(await noAddress.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "This build does not set the messenger address yet", path: SETUP_PATH });
    expect(noAddress.asked).toEqual([]);
  });
});
