// The onboarding step another plugin reads: its states and which machine it asks.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { ConnectionStatus } from "../contract";
import plugin from "../server";
import { SETUP_PATH, setupFromStatus } from "../src/shared/setup";

const base: ConnectionStatus = {
  platform: "darwin",
  user: "person",
  hasPassword: true,
  passwordStore: "keychain",
  blocked: false,
  addressChanged: false,
  lastCheck: { ok: true, at: 1, code: null, status: null },
};
const status = (patch: Partial<ConnectionStatus>): ConnectionStatus => ({ ...base, ...patch });
const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "fleet-kit" } };

describe("setupFromStatus", () => {
  it.each([
    ["not signed in", { user: null, hasPassword: false, passwordStore: null, lastCheck: null }, "todo", "Sign in with your login and password"],
    ["password missing", { hasPassword: false, passwordStore: null }, "todo", "Enter your password"],
    ["address changed", { addressChanged: true }, "todo", "The service address changed: sign in again"],
    ["refused", { blocked: true }, "problem", "Sign-in is paused: the service did not accept the password"],
    ["never checked", { lastCheck: null }, "todo", "Saved but the sign-in is not checked yet"],
    ["last check failed", { lastCheck: { ok: false, at: 1, code: "unreachable", status: null } }, "problem", "The last check failed, see the sign-in page"],
    ["signed in", {}, "done", "Signed in"],
  ] as const)("%s", (_name, patch, state, summary) => {
    expect(setupFromStatus(status(patch as Partial<ConnectionStatus>))).toEqual({ state, summary, path: SETUP_PATH });
  });

  it("speaks the language it is asked in", () => {
    expect(setupFromStatus(status({ user: null }), "ru").summary).toBe("Войдите своим логином и паролем");
    expect(setupFromStatus(status({}), "ru").summary).toBe("Вход выполнен");
  });

  it("never repeats the login", () => {
    expect(JSON.stringify(setupFromStatus(status({})))).not.toContain("person");
  });
});

async function setup(options: { hosts?: string[]; offline?: string[]; primary?: string | null; lastHost?: string; hostAnswer?: () => ConnectionStatus; baseUrl?: string } = {}) {
  const asked: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "http-data-service",
    settings: { allowedModels: "", baseUrl: options.baseUrl ?? "https://svc.example.com/api" },
    agentSkillIds: ["http-data-service"],
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => (options.hosts ?? ["host_mac"]).map((id) => ({ id, name: id, status: options.offline?.includes(id) ? "disconnected" : "connected", lifecycle: { phase: "ready" } })),
      },
      system: { config: async () => ({ primaryHostId: options.primary === undefined ? "host_mac" : options.primary }) },
    } as never,
    experimental_callHostRpc: async ({ method, hostId }) => {
      if (method === "forget") return status({ user: null });
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
    const { harness, asked } = await setup({ hostAnswer: () => status({ lastCheck: null }) });
    expect(await harness.callRpc("setupStatus", { lang: "ru" }, asPlugin)).toEqual({ state: "todo", summary: "Сохранено, но вход ещё не проверен", path: SETUP_PATH });
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
    for (const [method, input] of [["status", { hostId: "host_mac" }], ["machines", null], ["config", null], ["checkSignIn", { hostId: "host_mac" }], ["forget", { hostId: "host_mac" }]] as const) {
      await expect(harness.callRpc(method, input, asPlugin), method).rejects.toThrow(/does not answer other plugins/);
    }
  });

  it("reports a bb without machines, and a build without an address, as problems", async () => {
    const none = await setup({ hosts: [], primary: null });
    expect(await none.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "No machine is connected to bb", path: SETUP_PATH });
    const noAddress = await setup({ baseUrl: "", hostAnswer: () => status({}) });
    expect(await noAddress.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "This build does not set the service address yet", path: SETUP_PATH });
    expect(noAddress.asked).toEqual([]);
  });
});
