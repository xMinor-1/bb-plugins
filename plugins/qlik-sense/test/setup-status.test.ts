// The onboarding step another plugin reads: its states and which machine it asks.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { ConnectionStatus } from "../contract";
import plugin from "../server";
import { SETUP_PATH, setupFromStatus } from "../src/shared/setup";

const base: ConnectionStatus = {
  platform: "darwin",
  url: "https://qlik.example.com/",
  user: "EXAMPLE\\person",
  hasPassword: true,
  passwordStore: "keychain",
  blocked: null,
  lastCheck: { ok: true, at: 1, message: "Signed in.", apps: 12 },
  catalogApps: 3,
};
const status = (patch: Partial<ConnectionStatus>): ConnectionStatus => ({ ...base, ...patch });
const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "fleet-kit" } };

describe("setupFromStatus", () => {
  it.each([
    ["not connected", { url: null, user: null, hasPassword: false, passwordStore: null, lastCheck: null, catalogApps: 0 }, "todo", "Qlik is not connected yet"],
    ["password missing", { hasPassword: false, passwordStore: null }, "todo", "Enter the Qlik password"],
    ["sign-in refused", { blocked: "Qlik refused the password" }, "problem", "Sign-in stopped: Qlik did not accept the password"],
    ["saved, never checked", { lastCheck: null }, "todo", "Saved but the sign-in is not checked yet"],
    ["last check failed", { lastCheck: { ok: false, at: 1, message: "proxy 502", apps: null } }, "problem", "The last sign-in check failed, see the Qlik page"],
    ["signed in, no reports picked", { catalogApps: 0 }, "todo", "Signed in; now pick the reports agents may read"],
    ["signed in with reports", {}, "done", "Signed in; reports for agents: 3"],
  ] as const)("%s", (_name, patch, state, summary) => {
    expect(setupFromStatus(status(patch as Partial<ConnectionStatus>))).toEqual({ state, summary, path: SETUP_PATH });
  });

  it("speaks the language it is asked in", () => {
    expect(setupFromStatus(status({ url: null }), "ru").summary).toBe("Qlik ещё не подключён");
    expect(setupFromStatus(status({}), "ru").summary).toBe("Вход есть, отчётов для агентов: 3");
  });

  it("never repeats the address, the login or the host's message", () => {
    for (const patch of [{}, { lastCheck: { ok: false, at: 1, message: "qlik.example.com said 502", apps: null } }, { blocked: "EXAMPLE\\person" }]) {
      const text = JSON.stringify(setupFromStatus(status(patch as Partial<ConnectionStatus>)));
      for (const secret of ["qlik.example.com", "person", "502"]) expect(text).not.toContain(secret);
    }
  });
});

async function setup(options: { hosts?: string[]; offline?: string[]; primary?: string | null; lastHost?: string; hostAnswer?: () => ConnectionStatus } = {}) {
  const asked: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "qlik-sense",
    settings: { allowedModels: "" },
    agentSkillIds: ["qlik-sense"],
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () =>
          (options.hosts ?? ["host_mac"]).map((id) => ({ id, name: id, status: options.offline?.includes(id) ? "disconnected" : "connected", lifecycle: { phase: "ready" } })),
      },
      system: { config: async () => ({ primaryHostId: options.primary === undefined ? "host_mac" : options.primary }) },
    } as never,
    experimental_callHostRpc: async ({ method, hostId }) => {
      if (method === "saveCatalog") return { apps: [] };
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
    const { harness, asked } = await setup({ hostAnswer: () => status({ catalogApps: 0 }) });
    expect(await harness.callRpc("setupStatus", { lang: "ru" }, asPlugin)).toEqual({
      state: "todo",
      summary: "Вход есть, теперь выберите отчёты для агентов",
      path: SETUP_PATH,
    });
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
    expect(await offline.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "The machine with Qlik is not reachable", path: SETUP_PATH });
    expect(offline.asked).toEqual([]);
    const broken = await setup();
    expect(await broken.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "The plugin could not read its state on that machine", path: SETUP_PATH });
  });

  it("asks the host once for a few seconds, and again after a change on the panel", async () => {
    const { harness, asked } = await setup({ hostAnswer: () => status({}) });
    await harness.callRpc("setupStatus", {}, asPlugin);
    await harness.callRpc("setupStatus", { lang: "ru" }, asPlugin);
    expect(asked).toEqual(["host_mac"]);
    await harness.callRpc("saveCatalog", { hostId: "host_mac", catalog: { apps: [] } });
    await harness.callRpc("setupStatus", {}, asPlugin);
    expect(asked).toEqual(["host_mac", "host_mac"]);
  });

  it("keeps the panel's methods closed to other plugins", async () => {
    const { harness } = await setup({ hostAnswer: () => status({}) });
    for (const [method, input] of [["status", { hostId: "host_mac" }], ["machines", null], ["policy", null], ["saveCatalog", { hostId: "host_mac", catalog: { apps: [] } }]] as const) {
      await expect(harness.callRpc(method, input, asPlugin), method).rejects.toThrow(/does not answer other plugins/);
    }
    expect(await harness.callRpc("status", { hostId: "host_mac" })).toMatchObject({ url: "https://qlik.example.com/" });
  });

  it("reports a bb without machines as a problem", async () => {
    const none = await setup({ hosts: [], primary: null });
    expect(await none.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "No machine is connected to bb", path: SETUP_PATH });
    expect(none.asked).toEqual([]);
  });

  it("registers setupStatus beside the panel's methods", async () => {
    const { harness } = await setup();
    expect(harness.registrations.rpcMethods).toEqual(expect.arrayContaining(["status", "setupStatus"]));
  });
});
