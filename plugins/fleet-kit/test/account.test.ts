import { describe, expect, it } from "vitest";
import { accountVersion, bareLogin, checkAccount, handOut, loginFor, needsSignIn, type HandOutDeps } from "../src/account.js";
import { accountState } from "../src/setup.js";
import type { PluginAnswer } from "../src/setup.js";

describe("the login each plugin gets", () => {
  it("drops a domain the person typed and fills each template", () => {
    for (const typed of ["jdoe", "CORP\\jdoe", "jdoe@corp.example", " jdoe "]) expect(bareLogin(typed)).toBe("jdoe");
    expect(loginFor("CORP\\{login}", "jdoe@corp.example")).toBe("CORP\\jdoe");
    expect(loginFor("{login}@corp.example", "CORP\\jdoe")).toBe("jdoe@corp.example");
    expect(loginFor("{login}", "jdoe")).toBe("jdoe");
  });

  it("refuses an empty login and control characters", () => {
    expect(() => checkAccount("CORP\\", "x")).toThrow();
    expect(() => checkAccount("j doe", "x")).toThrow();
    expect(() => checkAccount("jdoe", "a\nb")).toThrow();
    expect(checkAccount(" jdoe ", "p")).toEqual({ login: "jdoe", password: "p" });
  });
});

const block = {
  plugins: [
    { plugin: "mail", login: "CORP\\{login}" },
    { plugin: "reports", login: "CORP\\{login}" },
    { plugin: "crm", login: "{login}", enabled: false },
    { plugin: "later", login: "{login}" },
  ],
  windows: [],
};
const value = { login: "jdoe", password: "secret-1" };

function deps(overrides: Partial<HandOutDeps> = {}) {
  const calls: Array<{ plugin: string; user: string }> = [];
  const value_: HandOutDeps = {
    block,
    value,
    results: {},
    installed: new Map([["mail", { enabled: true }], ["reports", { enabled: true }], ["crm", { enabled: true }]]),
    wanted: () => true,
    status: async () => ({ kind: "answer", state: "todo", summary: null, path: null }) as PluginAnswer,
    signIn: async (plugin, user) => {
      calls.push({ plugin, user });
      return { state: "done", summary: "Signed in" };
    },
    lang: "en",
    now: () => Date.parse("2026-11-08T10:00:00Z"),
    ...overrides,
  };
  return { value: value_, calls };
}

describe("handing the sign-in out", () => {
  it("signs in each installed plugin of the step in its own login form, never one that is off or missing", async () => {
    const { value: d, calls } = deps();
    const { results, changed } = await handOut(d);
    expect(changed).toBe(true);
    expect(calls).toEqual([{ plugin: "mail", user: "CORP\\jdoe" }, { plugin: "reports", user: "CORP\\jdoe" }]);
    expect(Object.keys(results).sort()).toEqual(["mail", "reports"]);
    expect(JSON.stringify(results)).not.toContain("secret-1");
  });

  it("leaves a plugin that is signed in already alone", async () => {
    const { value: d, calls } = deps({ status: async (plugin) => ({ kind: "answer", state: plugin === "mail" ? "done" : "todo", summary: "ok", path: null }) });
    const { results } = await handOut(d);
    expect(calls.map((call) => call.plugin)).toEqual(["reports"]);
    expect(results.mail!.state).toBe("done");
  });

  it("never sends a refused pair again, but does send a new one", async () => {
    const { value: d, calls } = deps({ signIn: async (plugin, user) => (calls.push({ plugin, user }), { state: "problem", summary: "No", rejected: true }) });
    const first = await handOut(d);
    expect(calls).toHaveLength(2);
    const again = await handOut({ ...d, results: first.results });
    expect(again.changed).toBe(false);
    expect(calls).toHaveLength(2);
    expect(needsSignIn(first.results.mail, accountVersion({ login: "jdoe", password: "secret-2" }))).toBe(true);
  });

  it("tries a plugin that did not answer a few times, and one that cannot take it only once", async () => {
    let n = 0;
    const failing = deps({
      signIn: async (plugin) => {
        n += 1;
        throw Object.assign(new Error("down"), { code: plugin === "mail" ? "internal" : "unknown_method" });
      },
    }).value;
    let results = {};
    for (let i = 0; i < 5; i += 1) results = (await handOut({ ...failing, results })).results;
    // mail: three tries; reports: an old version, one.
    expect(n).toBe(4);
    expect((results as Record<string, { reason?: string }>).reports!.reason).toBe("old-version");
  });
});

describe("the account step's state", () => {
  const line = (state: "done" | "todo" | "problem" | "waiting", summary: string | null = null) => ({ id: "x", title: "X", state, summary, reason: null, path: null });
  const step = (plugins: ReturnType<typeof line>[], saved: boolean, windows: Array<{ state: "done" | "todo" }> = []) => ({
    saved,
    loginHint: null,
    passwordHint: null,
    plugins,
    windows: windows.map((w) => ({ id: "w", title: "W", hint: null, method: "signIn", summary: null, path: null, ...w })),
    hostId: "host_1",
  });
  it("asks for the password until it is saved, unless every plugin is signed in already", () => {
    expect(accountState(step([line("todo")], false))).toBe("todo");
    expect(accountState(step([line("done")], false))).toBe("done");
  });
  it("is done once every plugin took the sign-in, also one with more to do on its own page", () => {
    expect(accountState(step([line("done"), line("todo", "Signed in; pick reports")], true))).toBe("done");
    expect(accountState(step([line("todo")], true))).toBe("checking");
    expect(accountState(step([line("waiting")], true))).toBe("installing");
    expect(accountState(step([line("problem")], true))).toBe("problem");
  });
  it("waits for a window sign-in", () => {
    expect(accountState(step([line("done")], true, [{ state: "todo" }]))).toBe("todo");
    expect(accountState(step([line("done")], true, [{ state: "done" }]))).toBe("done");
  });
});
