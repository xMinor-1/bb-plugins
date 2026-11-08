// One sign-in for several plugins: who may hand this plugin a login, and what it does with it.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { CheckResult, ConnectionStatus } from "../contract";
import plugin from "../server";
import { SETUP_PATH } from "../src/shared/setup";

const METHODS = [{ name: "stages", path: "agent/stages", summary: "List stages" }];
const SETTINGS = {
  allowedModels: "",
  baseUrl: "https://svc.example.com/api",
  methods: JSON.stringify(METHODS),
  checkMethod: "stages",
  accountPlugins: "fleet-kit, other-setup",
};
const LOGIN = "test-person";
const SECRET = "test-secret-value";
const asPlugin = (pluginId: string) => ({ experimental_caller: { kind: "plugin" as const, pluginId } });
const FLEET = asPlugin("fleet-kit");

const empty: ConnectionStatus = { platform: "darwin", user: null, hasPassword: false, passwordStore: null, blocked: false, addressChanged: false, lastCheck: null };

/** A machine that keeps its state the way the host entry does, and answers the check with `check`. */
async function setup(options: { settings?: Partial<typeof SETTINGS>; state?: Partial<ConnectionStatus>; check?: CheckResult; offline?: boolean } = {}) {
  const calls: { method: string; input: Record<string, unknown>; hostId: string }[] = [];
  let state: ConnectionStatus = { ...empty, ...options.state };
  const check = options.check ?? { ok: true, code: null, status: null };
  const { bb, harness } = createFakePluginHost({
    pluginId: "http-data-service",
    settings: { ...SETTINGS, ...options.settings },
    agentSkillIds: ["http-data-service"],
    experimental_hostEntry: true,
    sdk: {
      hosts: { list: async () => [{ id: "host_mac", name: "mac", status: options.offline ? "disconnected" : "connected", lifecycle: { phase: "ready" } }] },
      system: { config: async () => ({ primaryHostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      calls.push({ method, input: input as Record<string, unknown>, hostId });
      if (method === "status") return state;
      if (method === "saveConnection") {
        const { user } = input as { user: string };
        state = { ...state, user: user.trim(), hasPassword: true, passwordStore: "keychain", blocked: false, addressChanged: false, lastCheck: null };
        return state;
      }
      if (method === "checkSignIn") {
        state = { ...state, blocked: check.code === "unauthorized", lastCheck: { ...check, at: 1 } };
        return check;
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  await plugin(bb);
  const signIn = (input: Record<string, unknown> = {}, caller: unknown = FLEET) => harness.callRpc("accountSignIn", { user: LOGIN, password: SECRET, ...input }, caller as never);
  return { harness, calls, signIn, methods: () => calls.map((call) => call.method) };
}

describe("accountSignIn: who may call it", () => {
  it("refuses a plugin outside accountPlugins and names the setting", async () => {
    const s = await setup();
    await expect(s.signIn({}, asPlugin("sticker-note"))).rejects.toThrow(/accountPlugins/);
    expect(s.calls).toHaveLength(0);
  });

  it("refuses the panel, the CLI and agents", async () => {
    const s = await setup();
    await expect(s.signIn({}, { experimental_caller: { kind: "client" } })).rejects.toThrow(/accountPlugins/);
    expect(s.calls).toHaveLength(0);
  });

  it("refuses everyone with an empty or broken list", async () => {
    for (const accountPlugins of ["", "Fleet Kit!"]) {
      const s = await setup({ settings: { accountPlugins } });
      await expect(s.signIn()).rejects.toThrow(/accountPlugins/);
      expect(s.calls).toHaveLength(0);
    }
  });

  it("checks the input strictly", async () => {
    const s = await setup();
    await expect(s.signIn({ baseUrl: "https://evil.example.com" })).rejects.toThrow();
    await expect(s.signIn({ password: "" })).rejects.toThrow();
    expect(s.calls).toHaveLength(0);
  });
});

describe("accountSignIn: what it does", () => {
  it("saves the login as it came to the configured address, checks it, and answers the setup step", async () => {
    const s = await setup();
    const answer = await s.signIn({ user: ` ${LOGIN} `, lang: "ru" });
    expect(answer).toEqual({ state: "done", summary: "Вход выполнен", path: SETUP_PATH });
    expect(s.methods()).toEqual(["status", "saveConnection", "checkSignIn", "status"]);
    expect(s.calls[1]).toEqual({ method: "saveConnection", input: { baseUrl: "https://svc.example.com/api/", user: ` ${LOGIN} `, password: SECRET }, hostId: "host_mac" });
    expect(s.calls[2]).toMatchObject({ input: { baseUrl: "https://svc.example.com/api/", path: "agent/stages" } });
    expect(JSON.stringify(answer)).not.toContain(LOGIN);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("goes to the machine named", async () => {
    const s = await setup();
    await s.signIn({ hostId: "host_mac" });
    expect(new Set(s.calls.map((call) => call.hostId))).toEqual(new Set(["host_mac"]));
  });

  it.each([["a colon", "dom:person"], ["control characters", "per\u0007son"], ["only spaces", "   "], ["too long", "p".repeat(201)]])(
    "refuses a login with %s without asking the machine",
    async (_name, user) => {
      const s = await setup();
      expect(await s.signIn({ user })).toEqual({ state: "problem", summary: "The login must not be empty or contain a colon", path: SETUP_PATH });
      expect(s.calls).toHaveLength(0);
    },
  );

  it("refuses a password longer than the machine takes without asking it", async () => {
    const s = await setup();
    expect(await s.signIn({ password: "x".repeat(501) })).toMatchObject({ state: "problem", summary: "The password is too long" });
    expect(s.calls).toHaveLength(0);
  });

  it("says rejected only when the service refused the login or password", async () => {
    const refused = await setup({ check: { ok: false, code: "unauthorized", status: 401 } });
    expect(await refused.signIn()).toEqual({ state: "problem", summary: "Sign-in is paused: the service did not accept the password", path: SETUP_PATH, rejected: true });
    const down = await setup({ check: { ok: false, code: "unreachable", status: null } });
    const answer = await down.signIn();
    expect(answer).toEqual({ state: "problem", summary: "The last check failed, see the sign-in page", path: SETUP_PATH });
    expect(answer).not.toHaveProperty("rejected");
  });

  it("keeps a sign-in that works and only reports it", async () => {
    const s = await setup({ state: { user: "someone-else", hasPassword: true, passwordStore: "keychain", lastCheck: { ok: true, at: 1, code: null, status: null } } });
    expect(await s.signIn()).toEqual({ state: "done", summary: "Signed in", path: SETUP_PATH });
    expect(s.methods()).toEqual(["status"]);
  });

  it("replaces a sign-in that does not work yet", async () => {
    const s = await setup({ state: { user: "someone-else", hasPassword: true, passwordStore: "keychain", lastCheck: { ok: false, at: 1, code: "unreachable", status: null } } });
    expect(await s.signIn()).toMatchObject({ state: "done" });
    expect(s.methods()).toContain("saveConnection");
  });

  it("sends nothing while signing in is paused after a refusal", async () => {
    const s = await setup({ state: { user: "someone", hasPassword: true, passwordStore: "keychain", blocked: true, lastCheck: { ok: false, at: 1, code: "unauthorized", status: 401 } } });
    const answer = await s.signIn();
    expect(answer).toEqual({ state: "problem", summary: "Sign-in is paused: the service did not accept the password", path: SETUP_PATH });
    expect(s.methods()).toEqual(["status"]);
  });

  it("answers a build without an address or with broken settings without any request", async () => {
    const noAddress = await setup({ settings: { baseUrl: "" } });
    expect(await noAddress.signIn()).toEqual({ state: "problem", summary: "This build does not set the service address yet", path: SETUP_PATH });
    expect(noAddress.calls).toHaveLength(0);
    const broken = await setup({ settings: { checkMethod: "nope" } });
    expect(await broken.signIn()).toMatchObject({ state: "problem", summary: "This build's service settings need a fix" });
    expect(broken.calls).toHaveLength(0);
  });

  it("reports an unreachable machine without asking it", async () => {
    const s = await setup({ offline: true });
    expect(await s.signIn()).toMatchObject({ state: "problem", summary: "The machine is not reachable" });
    expect(s.calls).toHaveLength(0);
  });

  it("the setup step sees the new sign-in at once", async () => {
    const s = await setup();
    expect(await s.harness.callRpc("setupStatus", {}, FLEET)).toMatchObject({ state: "todo" });
    await s.signIn();
    expect(await s.harness.callRpc("setupStatus", {}, FLEET)).toMatchObject({ state: "done" });
  });
});
