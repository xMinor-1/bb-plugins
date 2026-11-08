// A sign-in handed over by a trusted plugin: who may call it, what reaches the
// host, and that a working connection and a paused login are left alone.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { ConnectionStatus } from "../contract";
import plugin from "../server";
import { SETUP_PATH } from "../src/shared/setup";

const URL = "https://mail.example.com/EWS/Exchange.asmx";
const USER = "EXAMPLE\\person";
const PASSWORD = "test-password-not-real";

const empty: ConnectionStatus = {
  platform: "darwin",
  curl: { path: "/usr/bin/curl", version: "8.7.1", negotiate: true, ntlm: true },
  curlError: null,
  url: null,
  auth: null,
  user: null,
  hasPassword: false,
  passwordStore: "Keychain",
  blocked: null,
  retryAt: null,
  lastCheck: null,
};
const asPlugin = (pluginId: string) => ({ experimental_caller: { kind: "plugin" as const, pluginId } });

interface Call {
  method: string;
  input: unknown;
}

/** A host that keeps one connection and answers the check with `checkAnswer`. */
async function setup(options: { ewsUrl?: string; accountPlugins?: string; start?: ConnectionStatus; checkAnswer?: { ok: boolean; message: string } } = {}) {
  const calls: Call[] = [];
  let state: ConnectionStatus = options.start ?? empty;
  const { bb, harness } = createFakePluginHost({
    pluginId: "exchange-mail",
    settings: { allowedModels: "", ewsUrl: options.ewsUrl ?? URL, accountPlugins: options.accountPlugins ?? "fleet-kit" },
    agentSkillIds: ["exchange-mail"],
    experimental_hostEntry: true,
    sdk: {
      hosts: { list: async () => [{ id: "host_mac", name: "host_mac", status: "connected", lifecycle: { phase: "ready" } }] },
      system: { config: async () => ({ primaryHostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input }) => {
      calls.push({ method, input });
      if (method === "status") return state;
      if (method === "saveConnection") {
        const saved = input as { url: string; auth: "password"; user: string };
        state = { ...state, url: saved.url, auth: saved.auth, user: saved.user, hasPassword: true, lastCheck: null };
        return state;
      }
      if (method === "check") {
        const answer = options.checkAnswer ?? { ok: true, message: "Connected. Inbox: 3 messages, 1 unread." };
        const refused = answer.message.startsWith("[mail:auth-refused]");
        state = {
          ...state,
          lastCheck: { ok: answer.ok, at: 1, message: answer.message },
          ...(refused ? { blocked: "Exchange did not accept the login and password.", retryAt: Date.now() + 15 * 60_000 } : {}),
        };
        return { ...answer, unread: answer.ok ? 1 : null };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  await plugin(bb);
  return { harness, calls, methods: () => calls.map((call) => call.method) };
}

const input = { user: USER, password: PASSWORD };

describe("accountSignIn RPC", () => {
  it("refuses a plugin outside accountPlugins and says what to add", async () => {
    const s = await setup();
    await expect(s.harness.callRpc("accountSignIn", input, asPlugin("other-plugin"))).rejects.toThrow(/add it to accountPlugins/);
    expect(s.calls).toEqual([]);
  });

  it("refuses the panel, the CLI and agents with a shell", async () => {
    const s = await setup();
    await expect(s.harness.callRpc("accountSignIn", input)).rejects.toThrow(/plugins listed in accountPlugins/);
    expect(s.calls).toEqual([]);
  });

  it("refuses everyone while accountPlugins is empty", async () => {
    const s = await setup({ accountPlugins: "" });
    await expect(s.harness.callRpc("accountSignIn", input, asPlugin("fleet-kit"))).rejects.toThrow(/accountPlugins/);
    expect(s.calls).toEqual([]);
  });

  it("saves a password sign-in to the configured address, checks it and answers like setupStatus", async () => {
    const s = await setup();
    const answer = await s.harness.callRpc("accountSignIn", { ...input, lang: "ru" }, asPlugin("fleet-kit"));
    expect(answer).toEqual({ state: "done", summary: "Почта подключена", path: SETUP_PATH });
    expect(s.methods()).toEqual(["status", "saveConnection", "check", "status"]);
    expect(s.calls[1]!.input).toEqual({ url: URL, auth: "password", user: USER, password: PASSWORD });
    // Neither the login nor the password comes back.
    expect(JSON.stringify(answer)).not.toContain(PASSWORD);
    expect(JSON.stringify(answer)).not.toContain("person");
  });

  it("marks a refused login and password as rejected", async () => {
    const s = await setup({ checkAnswer: { ok: false, message: "[mail:auth-refused] Exchange did not accept the login and password." } });
    const answer = await s.harness.callRpc("accountSignIn", input, asPlugin("fleet-kit"));
    expect(answer).toEqual({ state: "problem", summary: "Sign-in is paused: Exchange did not accept the password", path: SETUP_PATH, rejected: true });
  });

  it("does not call a network failure a rejected password", async () => {
    const s = await setup({ checkAnswer: { ok: false, message: "[mail:unreachable] Exchange did not answer." } });
    const answer = await s.harness.callRpc("accountSignIn", input, asPlugin("fleet-kit"));
    expect(answer).toEqual({ state: "problem", summary: "The last check failed, see the Mail page", path: SETUP_PATH });
  });

  it("leaves a working automatic sign-in alone", async () => {
    const s = await setup({ start: { ...empty, url: URL, auth: "negotiate", lastCheck: { ok: true, at: 1, message: "Connected." } } });
    expect(await s.harness.callRpc("accountSignIn", input, asPlugin("fleet-kit"))).toEqual({ state: "done", summary: "Mail is connected", path: SETUP_PATH });
    expect(s.methods()).toEqual(["status"]);
  });

  it("sends nothing while the login is paused after a refusal", async () => {
    const paused: ConnectionStatus = {
      ...empty,
      url: URL,
      auth: "password",
      user: "person@example.com",
      hasPassword: true,
      blocked: "Exchange did not accept the login and password.",
      retryAt: Date.now() + 10 * 60_000,
      lastCheck: { ok: false, at: 1, message: "[mail:auth-refused]" },
    };
    const s = await setup({ start: paused });
    expect(await s.harness.callRpc("accountSignIn", input, asPlugin("fleet-kit"))).toEqual({
      state: "problem",
      summary: "Sign-in is paused: Exchange did not accept the password",
      path: SETUP_PATH,
    });
    expect(s.methods()).toEqual(["status"]);
  });

  it("asks for the address first and makes no call without it", async () => {
    const s = await setup({ ewsUrl: "  " });
    expect(await s.harness.callRpc("accountSignIn", input, asPlugin("fleet-kit"))).toEqual({
      state: "problem",
      summary: "The Exchange address is not set in Exchange Mail's settings",
      path: SETUP_PATH,
    });
    expect(s.calls).toEqual([]);
  });

  it("rejects input outside the schema", async () => {
    const s = await setup();
    await expect(s.harness.callRpc("accountSignIn", { user: "", password: PASSWORD }, asPlugin("fleet-kit"))).rejects.toThrow();
    await expect(s.harness.callRpc("accountSignIn", { ...input, extra: 1 }, asPlugin("fleet-kit"))).rejects.toThrow();
    expect(s.calls).toEqual([]);
  });
});
