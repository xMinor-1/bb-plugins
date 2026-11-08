// Sign-in handed over by a trusted plugin: who may call it, what it saves and checks, and when it stays away from Qlik.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { ConnectionStatus } from "../contract";
import plugin from "../server";
import { SETUP_PATH } from "../src/shared/setup";

const URL_SETTING = "https://qlik.example.com/";
const USER = "EXAMPLE\\person";
const PASSWORD = "test-password-1";
const asPlugin = (pluginId: string) => ({ experimental_caller: { kind: "plugin" as const, pluginId } });
const fleet = asPlugin("fleet-kit");

const empty: ConnectionStatus = {
  platform: "darwin",
  url: null,
  user: null,
  hasPassword: false,
  passwordStore: null,
  blocked: null,
  lastCheck: null,
  catalogApps: 0,
};

/** A host that keeps its state like the real one: saving resets the check, a check records its result or blocks. */
async function setup(options: { url?: string; accountPlugins?: string; state?: Partial<ConnectionStatus>; check?: "ok" | "refused" | "down"; offline?: boolean } = {}) {
  let state: ConnectionStatus = { ...empty, ...options.state };
  const calls: { method: string; input: unknown }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "qlik-sense",
    settings: { allowedModels: "", url: options.url ?? URL_SETTING, accountPlugins: options.accountPlugins ?? "fleet-kit, other-plugin" },
    agentSkillIds: ["qlik-sense"],
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => [{ id: "host_mac", name: "mac", status: options.offline ? "disconnected" : "connected", lifecycle: { phase: "ready" } }],
      },
      system: { config: async () => ({ primaryHostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input }) => {
      calls.push({ method, input });
      if (method === "status") return state;
      if (method === "saveConnection") {
        const { url, user } = input as { url: string; user: string };
        state = { ...state, url, user, hasPassword: true, passwordStore: "keychain", blocked: null, lastCheck: null };
        return state;
      }
      if (method === "checkSignIn") {
        const check = options.check ?? "ok";
        if (check === "ok") {
          state = { ...state, lastCheck: { ok: true, at: 2, message: "Signed in. 4 apps available to this account.", apps: 4 } };
          return { ok: true, message: "Signed in.", apps: 4 };
        }
        const message = check === "refused" ? "Qlik did not accept the login or password (HTTP 403)." : "Qlik answered HTTP 502.";
        state = { ...state, blocked: check === "refused" ? message : null, lastCheck: { ok: false, at: 2, message, apps: null } };
        return { ok: false, message, apps: null };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  await plugin(bb);
  const methods = () => calls.map((call) => call.method);
  return { harness, calls, methods };
}

const signIn = { user: USER, password: PASSWORD };

describe("accountSignIn", () => {
  it("refuses plugins outside accountPlugins and the panel's own callers", async () => {
    const { harness, methods } = await setup();
    await expect(harness.callRpc("accountSignIn", signIn, asPlugin("stranger"))).rejects.toThrow(/stranger.*accountPlugins/);
    await expect(harness.callRpc("accountSignIn", signIn)).rejects.toThrow(/accountPlugins/);
    const none = await setup({ accountPlugins: "" });
    await expect(none.harness.callRpc("accountSignIn", signIn, fleet)).rejects.toThrow(/accountPlugins/);
    expect([...methods(), ...none.methods()]).toEqual([]);
  });

  it("saves the account at the configured address, checks it and answers the setup step", async () => {
    const { harness, calls, methods } = await setup();
    const answer = await harness.callRpc("accountSignIn", { ...signIn, lang: "en" }, fleet);
    expect(answer).toEqual({ state: "todo", summary: "Signed in; now pick the reports agents may read", path: SETUP_PATH });
    expect(methods()).toEqual(["status", "saveConnection", "checkSignIn", "status"]);
    expect(calls[1]!.input).toEqual({ url: URL_SETTING, user: USER, password: PASSWORD });
    const text = JSON.stringify(answer);
    for (const secret of [PASSWORD, "person", "qlik.example.com"]) expect(text).not.toContain(secret);
  });

  it("refuses a login without a domain before asking Qlik", async () => {
    const { harness, methods } = await setup();
    expect(await harness.callRpc("accountSignIn", { user: "person", password: PASSWORD, lang: "ru" }, fleet)).toEqual({
      state: "problem",
      summary: "Логин нужен с доменом: DOMAIN\\user",
      path: SETUP_PATH,
    });
    expect(methods()).toEqual([]);
  });

  it("flags a refused login or password so the caller does not send it again", async () => {
    const { harness } = await setup({ check: "refused" });
    expect(await harness.callRpc("accountSignIn", signIn, fleet)).toEqual({
      state: "problem",
      summary: "Sign-in stopped: Qlik did not accept the password",
      path: SETUP_PATH,
      rejected: true,
    });
  });

  it("does not flag a failure that is not about the password", async () => {
    const { harness } = await setup({ check: "down" });
    const answer = await harness.callRpc("accountSignIn", signIn, fleet);
    expect(answer).toEqual({ state: "problem", summary: "The last sign-in check failed, see the Qlik page", path: SETUP_PATH });
  });

  it("leaves a working sign-in as it is", async () => {
    const working = { url: URL_SETTING, user: "EXAMPLE\\someone", hasPassword: true, passwordStore: "keychain" as const, lastCheck: { ok: true, at: 1, message: "Signed in.", apps: 4 }, catalogApps: 2 };
    const { harness, methods } = await setup({ state: working });
    expect(await harness.callRpc("accountSignIn", signIn, fleet)).toEqual({ state: "done", summary: "Signed in; reports for agents: 2", path: SETUP_PATH });
    expect(methods()).toEqual(["status"]);
  });

  it("keeps away from Qlik while an earlier refusal blocks sign-ins", async () => {
    const blocked = { url: URL_SETTING, user: USER, hasPassword: true, passwordStore: "keychain" as const, blocked: "Qlik did not accept the login or password (HTTP 403).", lastCheck: { ok: false, at: 1, message: "refused", apps: null } };
    const { harness, methods } = await setup({ state: blocked });
    expect(await harness.callRpc("accountSignIn", signIn, fleet)).toEqual({
      state: "problem",
      summary: "Sign-in stopped: Qlik did not accept the password",
      path: SETUP_PATH,
    });
    expect(methods()).toEqual(["status"]);
  });

  it("answers a problem without the network when there is no address or machine", async () => {
    const noUrl = await setup({ url: "" });
    expect(await noUrl.harness.callRpc("accountSignIn", signIn, fleet)).toEqual({
      state: "problem",
      summary: "The Qlik Sense address is not set in the plugin settings",
      path: SETUP_PATH,
    });
    const offline = await setup({ offline: true });
    expect(await offline.harness.callRpc("accountSignIn", signIn, fleet)).toMatchObject({ state: "problem", summary: "The machine with Qlik is not reachable" });
    expect([...noUrl.methods(), ...offline.methods()]).toEqual([]);
  });

  it("rejects a login or password longer than the host keeps, before asking Qlik", async () => {
    const { harness, methods } = await setup();
    expect(await harness.callRpc("accountSignIn", { user: USER, password: "x".repeat(600) }, fleet)).toMatchObject({ state: "problem", summary: "The login or password is too long for Qlik Sense" });
    await expect(harness.callRpc("accountSignIn", { ...signIn, extra: 1 }, fleet)).rejects.toThrow();
    expect(methods()).toEqual([]);
  });
});
