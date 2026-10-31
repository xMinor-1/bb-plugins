// The onboarding step another plugin reads: its states, which machine it asks,
// and that it answers other plugins while the panel's methods still refuse them.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { ConnectionStatus } from "../contract";
import plugin from "../server";
import { SETUP_PATH, setupFromStatus } from "../src/shared/setup";

const base: ConnectionStatus = {
  platform: "darwin",
  curl: { path: "/usr/bin/curl", version: "8.7.1", negotiate: true, ntlm: true },
  curlError: null,
  url: "https://mail.example.com/EWS/Exchange.asmx",
  auth: "password",
  user: "EXAMPLE\\person",
  hasPassword: true,
  passwordStore: "Keychain",
  blocked: null,
  retryAt: null,
  lastCheck: { ok: true, at: 1, message: "Connected." },
};
const status = (patch: Partial<ConnectionStatus>): ConnectionStatus => ({ ...base, ...patch });
const asPlugin = { experimental_caller: { kind: "plugin" as const, pluginId: "fleet-kit" } };

describe("setupFromStatus", () => {
  it.each([
    ["not connected", { url: null, auth: null, user: null, hasPassword: false, lastCheck: null }, "todo", "Mail is not connected yet"],
    ["password missing", { hasPassword: false }, "todo", "Enter the mail password"],
    ["saved, never checked", { lastCheck: null }, "todo", "Saved but not checked yet"],
    ["curl does not start", { curl: null, curlError: "[mail:curl-missing:curl]" }, "problem", "curl did not start on this machine"],
    ["sign-in paused", { blocked: "Exchange refused the password", retryAt: 5 }, "problem", "Sign-in is paused: Exchange did not accept the password"],
    ["last check failed", { lastCheck: { ok: false, at: 1, message: "[mail:unreachable]" } }, "problem", "The last check failed, see the Mail page"],
    ["connected with a password", {}, "done", "Mail is connected"],
    ["connected with automatic sign-in", { auth: "negotiate", user: null, hasPassword: false }, "done", "Mail is connected"],
  ] as const)("%s", (_name, patch, state, summary) => {
    expect(setupFromStatus(status(patch as Partial<ConnectionStatus>))).toEqual({ state, summary, path: SETUP_PATH });
  });

  it("speaks the language it is asked in", () => {
    expect(setupFromStatus(status({ url: null }), "ru").summary).toBe("Почта ещё не подключена");
    expect(setupFromStatus(status({}), "ru").summary).toBe("Почта подключена");
  });

  it("never repeats the address, the login or the host's message", () => {
    for (const patch of [{}, { lastCheck: { ok: false, at: 1, message: "curl: (6) mail.example.com" } }, { blocked: "EXAMPLE\\person" }]) {
      const text = JSON.stringify(setupFromStatus(status(patch as Partial<ConnectionStatus>)));
      for (const secret of ["mail.example.com", "person", "curl: (6)"]) expect(text).not.toContain(secret);
    }
  });
});

async function setup(options: { hosts?: string[]; primary?: string | null; lastHost?: string; hostAnswer?: (hostId: string) => ConnectionStatus } = {}) {
  const asked: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "exchange-mail",
    settings: { allowedModels: "", ewsUrl: "" },
    agentSkillIds: ["exchange-mail"],
    experimental_hostEntry: true,
    sdk: {
      hosts: { list: async () => (options.hosts ?? ["host_mac"]).map((id) => ({ id, name: id, status: "connected", lifecycle: { phase: "ready" } })) },
      system: { config: async () => ({ primaryHostId: options.primary === undefined ? "host_mac" : options.primary }) },
    } as never,
    experimental_callHostRpc: async ({ method, hostId }) => {
      if (method !== "status") throw new Error(`unexpected ${method}`);
      asked.push(hostId);
      if (!options.hostAnswer) throw new Error("host offline");
      return options.hostAnswer(hostId);
    },
  });
  await plugin(bb);
  if (options.lastHost) await bb.storage.kv.set("ui:lastHost", options.lastHost);
  return { harness, asked };
}

describe("setupStatus RPC", () => {
  it("answers another plugin from bb's own machine", async () => {
    const { harness, asked } = await setup({ hostAnswer: () => status({ lastCheck: null }) });
    expect(await harness.callRpc("setupStatus", { lang: "ru" }, asPlugin)).toEqual({ state: "todo", summary: "Сохранено, но ещё не проверено", path: SETUP_PATH });
    expect(asked).toEqual(["host_mac"]);
  });

  it("asks the machine the panel used last, or the one named", async () => {
    const { harness, asked } = await setup({ hosts: ["host_mac", "host_win"], lastHost: "host_win", hostAnswer: () => status({}) });
    expect((await harness.callRpc("setupStatus", {}, asPlugin)) as { state: string }).toMatchObject({ state: "done" });
    await harness.callRpc("setupStatus", { hostId: "host_mac" }, asPlugin);
    expect(asked).toEqual(["host_win", "host_mac"]);
  });

  it("falls back to bb's machine when the panel's machine is gone", async () => {
    const { harness, asked } = await setup({ lastHost: "host_gone", hostAnswer: () => status({}) });
    await harness.callRpc("setupStatus", {}, asPlugin);
    expect(asked).toEqual(["host_mac"]);
  });

  it("reports an unreachable machine and a bb without machines as problems", async () => {
    const offline = await setup();
    expect(await offline.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "The machine with mail is not reachable", path: SETUP_PATH });
    const none = await setup({ hosts: [], primary: null });
    expect(await none.harness.callRpc("setupStatus", {}, asPlugin)).toEqual({ state: "problem", summary: "No machine is connected to bb", path: SETUP_PATH });
    expect(none.asked).toEqual([]);
  });

  it("keeps the panel's methods closed to other plugins", async () => {
    const { harness } = await setup({ hostAnswer: () => status({}) });
    await expect(harness.callRpc("status", { hostId: "host_mac" }, asPlugin)).rejects.toThrow(/does not answer other plugins/);
  });

  it("registers setupStatus beside the panel's methods", async () => {
    const { harness } = await setup();
    expect(harness.registrations.rpcMethods).toEqual(expect.arrayContaining(["status", "setupStatus"]));
  });
});
