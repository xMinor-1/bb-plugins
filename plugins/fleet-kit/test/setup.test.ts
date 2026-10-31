// The First run page's data: each kind of step, what a plugin's answer turns
// into, manual marks and skips, and what counts as left to do.
import { describe, expect, it } from "vitest";
import type { SyncReport } from "../contract";
import { checkManifest } from "../src/manifest";
import { collectSetup, markProblem, type SetupDeps, type StoredOnboarding } from "../src/setup";
import { clone, sampleManifest } from "./fixtures";

type Answer = { state: string; summary: string; path?: string } | Error | "hang";

function rpcError(code: string) {
  return Object.assign(new Error(code), { code });
}

function deps(options: {
  onboarding?: StoredOnboarding | null;
  installed?: { id: string; enabled: boolean }[] | Error;
  answers?: Record<string, Answer>;
  marks?: SetupDeps["marks"];
  secrets?: string[];
  lastSync?: SyncReport | null;
}) {
  const calls: { pluginId: string; method: string; input: unknown }[] = [];
  const value: SetupDeps = {
    sdk: {
      plugins: {
        list: async () => {
          if (options.installed instanceof Error) throw options.installed;
          return { plugins: options.installed ?? [{ id: "mail", enabled: true }, { id: "qlik", enabled: true }, { id: "notes", enabled: true }] };
        },
        callRpc: async (args: { pluginId: string; method: string; input?: unknown; outputSchema: { parse: (v: unknown) => unknown }; signal?: AbortSignal }) => {
          calls.push({ pluginId: args.pluginId, method: args.method, input: args.input });
          const answer = options.answers?.[args.pluginId];
          if (answer === undefined) throw rpcError("unknown_method");
          if (answer instanceof Error) throw answer;
          if (answer === "hang") {
            return new Promise((_, reject) => args.signal?.addEventListener("abort", () => reject(rpcError("transport_error"))));
          }
          return args.outputSchema.parse(answer);
        },
      },
    } as never,
    onboarding:
      options.onboarding === undefined
        ? {
            steps: [
              { id: "key", title: "Gateway key", secret: "gateway-key" },
              { id: "mail", title: "Mail", plugin: "mail" },
              { id: "qlik", title: "Qlik", plugin: "qlik", hint: "Pick reports" },
              { id: "mcp", title: "Own MCP", plugin: "mcp-catalog", optional: true },
              { id: "voice", title: "Voice", plugin: "voice", optional: true },
            ],
            planned: ["voice"],
          }
        : options.onboarding,
    marks: options.marks ?? {},
    secrets: [{ name: "gateway-key", hint: "From the gateway portal" }],
    secretSet: async (name) => (options.secrets ?? []).includes(name),
    secretStore: "macOS Keychain",
    lastSync: options.lastSync ?? null,
    lang: "ru",
    timeoutMs: 50,
  };
  return { value, calls };
}

const byId = (setup: Awaited<ReturnType<typeof collectSetup>>, id: string) => setup.steps.find((step) => step.id === id)!;

describe("collectSetup", () => {
  it("has nothing to show before the first sync", async () => {
    const setup = await collectSetup(deps({ onboarding: null }).value);
    expect(setup).toMatchObject({ configured: false, steps: [], complete: false });
  });

  it("a build without steps is complete and asks nobody", async () => {
    const { value, calls } = deps({ onboarding: { steps: [], planned: [] } });
    expect(await collectSetup(value)).toMatchObject({ configured: true, steps: [], remaining: 0, complete: true });
    expect(calls).toEqual([]);
  });

  it("asks each installed plugin in the page's language and takes its answer", async () => {
    const { value, calls } = deps({
      secrets: ["gateway-key"],
      installed: [{ id: "mail", enabled: true }, { id: "qlik", enabled: true }, { id: "mcp-catalog", enabled: true }],
      answers: {
        mail: { state: "done", summary: "Почта подключена", path: "/plugins/mail/mail" },
        qlik: { state: "todo", summary: "Вход есть, теперь выберите отчёты для агентов", path: "/plugins/qlik/qlik-sense" },
        "mcp-catalog": { state: "problem", summary: "Проверка не прошла", path: "/plugins/mcp-catalog/mcp" },
      },
    });
    const setup = await collectSetup(value);
    expect(calls).toEqual([
      { pluginId: "mail", method: "setupStatus", input: { lang: "ru" } },
      { pluginId: "qlik", method: "setupStatus", input: { lang: "ru" } },
      { pluginId: "mcp-catalog", method: "setupStatus", input: { lang: "ru" } },
    ]);
    expect(byId(setup, "key")).toMatchObject({ kind: "secret", target: "gateway-key", state: "done", hint: "From the gateway portal", path: null });
    expect(byId(setup, "mail")).toMatchObject({ kind: "plugin", state: "done", summary: "Почта подключена", path: "/plugins/mail/mail", manual: false });
    expect(byId(setup, "qlik")).toMatchObject({ state: "todo", hint: "Pick reports", path: "/plugins/qlik/qlik-sense" });
    expect(byId(setup, "mcp")).toMatchObject({ state: "problem", summary: "Проверка не прошла" });
    expect(byId(setup, "voice")).toMatchObject({ state: "later", path: null });
    expect(setup).toMatchObject({ configured: true, remaining: 2, complete: false, secretStore: "macOS Keychain" });
  });

  it("does not ask a plugin that is planned, not installed yet or turned off", async () => {
    const { value, calls } = deps({ installed: [{ id: "qlik", enabled: false }], answers: { mail: { state: "done", summary: "" } } });
    const setup = await collectSetup(value);
    expect(calls).toEqual([]);
    expect(byId(setup, "mail").state).toBe("installing");
    expect(byId(setup, "qlik").state).toBe("installing");
    expect(byId(setup, "voice").state).toBe("later");
  });

  it("shows a plugin the last sync failed to install as a problem", async () => {
    const lastSync = { steps: [{ area: "plugin", item: "mail", outcome: "error", message: "install failed" }] } as unknown as SyncReport;
    const setup = await collectSetup(deps({ installed: [], lastSync }).value);
    expect(byId(setup, "mail")).toMatchObject({ state: "problem", reason: "install-failed" });
    expect(byId(setup, "qlik")).toMatchObject({ state: "installing", reason: null });
  });

  it("lets the person mark a plugin without setupStatus, and leads to the step's own page", async () => {
    const { value } = deps({
      onboarding: { steps: [{ id: "notes", title: "Notes", plugin: "notes", path: "/plugins/notes/board" }], planned: [] },
    });
    const before = await collectSetup(value);
    expect(byId(before, "notes")).toMatchObject({ state: "todo", manual: true, reason: "manual", path: "/plugins/notes/board" });
    const after = await collectSetup({ ...value, marks: { notes: "done" } });
    expect(byId(after, "notes")).toMatchObject({ state: "done", manual: true, mark: "done" });
    expect(after.complete).toBe(true);
  });

  it("ignores a hand mark when the plugin can say for itself", async () => {
    const { value } = deps({ marks: { mail: "done" }, answers: { mail: { state: "todo", summary: "Почта ещё не подключена" } } });
    expect(byId(await collectSetup(value), "mail")).toMatchObject({ state: "todo", manual: false, mark: "done" });
  });

  it("shows a plugin that fails or does not answer in time as a problem, without waiting for it", async () => {
    const { value } = deps({ answers: { mail: rpcError("handler_error"), qlik: "hang" } });
    const started = Date.now();
    const setup = await collectSetup(value);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(byId(setup, "mail")).toMatchObject({ state: "problem", reason: "no-answer", manual: false });
    expect(byId(setup, "qlik")).toMatchObject({ state: "problem", reason: "no-answer" });
  });

  it("refuses a plugin's answer of the wrong shape and a page outside bb", async () => {
    const { value } = deps({
      answers: { mail: { state: "finished", summary: "?" }, qlik: { state: "done", summary: "ok", path: "https://evil.example.test/" } },
    });
    const setup = await collectSetup(value);
    expect(byId(setup, "mail")).toMatchObject({ state: "problem", reason: "no-answer" });
    expect(byId(setup, "qlik")).toMatchObject({ state: "done", path: null });
  });

  it("asks the plugins anyway when the plugin list cannot be read", async () => {
    const { value, calls } = deps({ installed: new Error("bb busy"), answers: { mail: { state: "done", summary: "" } } });
    const setup = await collectSetup(value);
    expect(calls.map((call) => call.pluginId)).toEqual(["mail", "qlik", "mcp-catalog"]);
    expect(byId(setup, "mail")).toMatchObject({ state: "done", summary: null });
  });

  it("counts a skipped optional step as handled, and everything done as complete", async () => {
    const answers = { mail: { state: "done", summary: "" }, qlik: { state: "done", summary: "" } };
    const { value } = deps({ secrets: ["gateway-key"], answers });
    const open = await collectSetup(value);
    expect(open).toMatchObject({ remaining: 1, complete: false });
    expect(byId(open, "mcp")).toMatchObject({ state: "installing", optional: true });
    const skipped = await collectSetup({ ...value, marks: { mcp: "skipped" } });
    expect(skipped).toMatchObject({ remaining: 0, complete: true });
  });
});

describe("markProblem", () => {
  const steps = [
    { id: "key", title: "Key", secret: "gateway-key" },
    { id: "mail", title: "Mail", plugin: "mail" },
    { id: "mcp", title: "MCP", plugin: "mcp", optional: true },
  ];
  it("allows marking plugin steps done, skipping optional ones, and clearing", () => {
    expect(markProblem(steps[1], "done")).toBeNull();
    expect(markProblem(steps[2], "skipped")).toBeNull();
    expect(markProblem(steps[0], null)).toBeNull();
  });
  it("refuses unknown steps, skipping required ones and marking a secret by hand", () => {
    expect(markProblem(undefined, "done")).toMatch(/no such/);
    expect(markProblem(steps[1], "skipped")).toMatch(/optional/);
    expect(markProblem(steps[0], "done")).toMatch(/secret/);
  });
});

describe("manifest onboarding", () => {
  const withSteps = (steps: unknown[]) => ({ ...clone(sampleManifest()), onboarding: steps });

  it("reads the steps in order", () => {
    const steps = [
      { id: "key", title: "Gateway key", secret: "gateway-key" },
      { id: "notes", title: "Notes", hint: "Open the board", plugin: "notes", path: "/plugins/notes/board" },
      { id: "later", title: "Later", plugin: "later", optional: true },
    ];
    const check = checkManifest(withSteps(steps));
    expect(check.errors).toEqual([]);
    expect(check.warnings.filter((w) => w.startsWith("onboarding"))).toEqual([]);
    expect(check.manifest?.onboarding).toEqual(steps);
  });

  it("keeps a manifest without onboarding as it was", () => {
    const check = checkManifest(clone(sampleManifest()));
    expect(check.errors).toEqual([]);
    expect(check.manifest?.onboarding).toBeUndefined();
  });

  it.each([
    ["both a secret and a plugin", { id: "x", title: "X", secret: "gateway-key", plugin: "notes" }],
    ["neither a secret nor a plugin", { id: "x", title: "X" }],
    ["a page for a secret step", { id: "x", title: "X", secret: "gateway-key", path: "/plugins/fleet-kit/setup" }],
    ["a page outside bb", { id: "x", title: "X", plugin: "notes", path: "https://notes.example.test/" }],
    ["an unknown field", { id: "x", title: "X", plugin: "notes", required: true }],
  ])("refuses a step with %s", (_name, step) => {
    expect(checkManifest(withSteps([step])).errors.some((error) => error.startsWith("onboarding.0"))).toBe(true);
  });

  it("hides a step that refers to nothing, with a warning, and applies the rest of the build", () => {
    const check = checkManifest(
      withSteps([
        { id: "key", title: "Key", secret: "other-key" },
        { id: "mail", title: "Mail", plugin: "mail-x" },
        { id: "notes", title: "Notes", plugin: "notes" },
        { id: "notes", title: "Notes again", plugin: "notes" },
      ]),
    );
    expect(check.errors).toEqual([]);
    expect(check.manifest?.onboarding?.map((step) => step.id)).toEqual(["notes"]);
    expect(check.warnings.filter((w) => w.startsWith("onboarding"))).toEqual([
      'onboarding.key: refers to the secret "other-key", which is not in secrets; the step is not shown',
      'onboarding.mail: refers to the plugin "mail-x", which is not in plugins; the step is not shown',
      "onboarding.notes: is listed twice; the step is not shown",
    ]);
  });
});
