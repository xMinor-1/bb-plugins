import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallOutcome } from "../src/host/install-opencode.js";
import { emptyManaged, runSync, type ManagedState, type SyncDeps } from "../src/sync.js";
import { consentKey } from "../src/own-agents.js";
import { openFileSecretStore } from "../src/secret-store.js";
import { clone, sampleManifest } from "./fixtures.js";

interface FakePlugin {
  id: string;
  source: string;
  version: string;
  enabled: boolean;
  provenance?: "builtin" | "direct";
  schema: Record<string, { type: string; secret?: boolean }>;
  values: Record<string, unknown>;
  update?: string;
  /** What bb's getSource reports for it. */
  subdirectory?: string;
}

const SELF_SOURCE = "git:https://git.example.test/plugins.git@semver:fleet-kit/:^0.1.0";
const NOTES_SOURCE = "git:https://git.example.test/plugins.git@semver:notes/:^1.0.0";

/** The id a fake source installs: the word after "plugins.git@semver:" or a marker in the source. */
function idFor(source: string): string {
  if (source.includes("wrong")) return "wrong";
  if (source.includes("notes")) return "notes";
  if (source.includes("reports")) return "reports";
  if (source.includes("extra")) return "extra";
  if (source.includes("board")) return "board";
  return "other";
}

function fakeSdk(initial: FakePlugin[], general: Record<string, unknown> = { telemetryEnabled: true, streamerMode: false }) {
  const plugins = new Map(initial.map((plugin) => [plugin.id, clone(plugin)]));
  const calls: string[] = [];
  const installs: Array<{ source: string; plugin?: string; subdirectory?: string }> = [];
  /** Installs of a "slow" source wait here until a test finishes them. */
  const slow: Array<{ source: string; finish: () => void }> = [];
  const updateJobs: Array<{ id: string; pluginId: string; state: string }> = [];
  /** Set to make bb's install job list fail. */
  const jobs = { unavailable: false };
  type Selection = { mode: "automatic" } | { mode: "off" } | { mode: "service"; pluginId: string; serviceId: string };
  const ai = {
    selections: { "thread-title": { mode: "automatic" }, "commit-message": { mode: "automatic" }, voice: { mode: "automatic" } } as Record<string, Selection>,
    services: [{ id: "bb-cloud", displayName: "bb cloud", pluginId: "bb-ai", tasks: ["thread-title", "commit-message", "voice"], automaticRank: 0, status: { ready: true } }] as Array<Record<string, unknown>>,
  };
  const agents = [
    { id: "acp-opencode", displayName: "OpenCode", enabled: true, available: true, pluginEnabled: true },
    { id: "codex", displayName: "Codex", enabled: true, available: true, pluginEnabled: true },
    { id: "claude-code", displayName: "Claude Code", enabled: true, available: false, pluginEnabled: true },
    { id: "cursor", displayName: "Cursor", enabled: false, available: false, pluginEnabled: true },
  ];
  const view = (plugin: FakePlugin) => ({ id: plugin.id, source: plugin.source, version: plugin.version, enabled: plugin.enabled, provenance: plugin.provenance ?? "direct" });
  const schemaFor = (id: string): FakePlugin["schema"] =>
    id === "notes" ? { greeting: { type: "string" }, token: { type: "string", secret: true }, allowedProviders: { type: "string" }, officePath: { type: "string" } } : {};
  const sdk = {
    system: {
      version: async () => ({ currentVersion: "0.48.1" }),
      aiServices: async () => clone({ selections: ai.selections, services: ai.services }),
      setAiServiceSelection: async ({ task, selection }: { task: string; selection: Selection }) => {
        calls.push(`ai ${task} ${selection.mode === "service" ? `${selection.pluginId}/${selection.serviceId}` : selection.mode}`);
        ai.selections[task] = selection;
        return clone({ selections: ai.selections, services: ai.services });
      },
      config: async () => ({ generalSettings: { ...general }, primaryHostId: "host_1" }),
      updateGeneralSettings: async (next: Record<string, unknown>) => {
        calls.push(`settings ${JSON.stringify(next)}`);
        Object.assign(general, next);
      },
    },
    providers: {
      catalog: async () => clone(agents),
      setEnabled: async ({ providerId, enabled }: { providerId: string; enabled: boolean }) => {
        calls.push(`agent ${providerId} ${enabled ? "on" : "off"}`);
        const entry = agents.find((one) => one.id === providerId)!;
        // bb refuses to turn on an agent it cannot run (409 provider_unavailable).
        if (enabled && !(entry.available && entry.pluginEnabled)) throw new Error("Provider is unavailable (provider_unavailable)");
        entry.enabled = enabled;
        return clone(agents);
      },
    },
    plugins: {
      marketplaces: { list: async () => [], add: async () => ({}) },
      list: async () => ({ plugins: [...plugins.values()].map(view) }),
      install: async (args: { source: string; plugin?: string; subdirectory?: string }) => {
        const { source } = args;
        installs.push(args);
        if (source.includes("broken")) {
          calls.push(`install-failed ${source}`);
          throw new Error("could not clone");
        }
        const id = idFor(source);
        const land = () => {
          const plugin: FakePlugin = { id, source, version: "1.0.0", enabled: true, schema: schemaFor(id), values: {} };
          plugins.set(id, plugin);
          return view(plugin);
        };
        if (source.includes("slow")) {
          calls.push(`install-started ${id}`);
          return new Promise((resolve) => {
            const job = { source, finish: () => { slow.splice(slow.indexOf(job), 1); resolve(land()); } };
            slow.push(job);
          });
        }
        calls.push(`install ${id}`);
        return land();
      },
      installJobs: {
        list: async () => {
          if (jobs.unavailable) throw new Error("install jobs are unavailable");
          return slow.map((job, index) => ({ id: `job_${index}`, displayName: job.source, state: "running", target: { kind: "source", source: job.source, selection: { kind: "root" } } }));
        },
      },
      getSource: async ({ pluginId }: { pluginId: string }) => {
        const plugin = plugins.get(pluginId)!;
        return { requested: plugin.source, resolved: plugin.source, history: [], engines: {}, ...(plugin.subdirectory ? { subdirectory: plugin.subdirectory } : {}) };
      },
      experimental_updateJobs: { list: async () => updateJobs },
      remove: async ({ pluginId }: { pluginId: string }) => {
        calls.push(`remove ${pluginId}`);
        plugins.delete(pluginId);
        return { ok: true };
      },
      disable: async ({ pluginId }: { pluginId: string }) => {
        calls.push(`disable ${pluginId}`);
        const plugin = plugins.get(pluginId)!;
        plugin.enabled = false;
        return view(plugin);
      },
      enable: async ({ pluginId }: { pluginId: string }) => {
        calls.push(`enable ${pluginId}`);
        const plugin = plugins.get(pluginId)!;
        plugin.enabled = true;
        return view(plugin);
      },
      checkUpdates: async ({ pluginId }: { pluginId: string }) => {
        const plugin = plugins.get(pluginId);
        if (pluginId === "fleet-kit") calls.push("check fleet-kit");
        return [
          plugin?.update
            ? { id: pluginId, outcome: "update-available", candidate: { version: plugin.update, label: plugin.update, display: plugin.update } }
            : { id: pluginId, outcome: "current" },
        ];
      },
      applyUpdate: async ({ pluginId }: { pluginId: string }) => {
        const plugin = plugins.get(pluginId)!;
        calls.push(`update ${pluginId}`);
        plugin.version = plugin.update!;
        delete plugin.update;
        return { applied: true, outcome: "updated", to: { label: plugin.version } };
      },
      getSettings: async ({ pluginId }: { pluginId: string }) => {
        const plugin = plugins.get(pluginId)!;
        const values: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(plugin.values)) values[key] = plugin.schema[key]?.secret ? { set: true } : value;
        return { ok: true, schema: plugin.schema, values };
      },
      updateSettings: async ({ pluginId, values }: { pluginId: string; values: Record<string, unknown> }) => {
        calls.push(`config ${pluginId} ${Object.keys(values).sort().join(",")}`);
        Object.assign(plugins.get(pluginId)!.values, values);
        return { ok: true };
      },
    },
  };
  return { sdk, plugins, calls, general, installs, slow, updateJobs, jobs, ai, agents };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(manifest: Record<string, unknown>, initial: FakePlugin[], managed: ManagedState = emptyManaged()) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-kit-sync-"));
  dirs.push(dir);
  const path = join(dir, "manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  const fake = fakeSdk(initial);
  const store = openFileSecretStore(join(dir, "secrets"));
  const deps: SyncDeps = {
    sdk: fake.sdk as unknown as SyncDeps["sdk"],
    log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as SyncDeps["log"],
    settings: { manifestUrl: path, manifestToken: undefined, syncIntervalMinutes: 30, opencodeConfigDir: "", allowDevSources: false, paused: false },
    store,
    managed,
    signal: new AbortController().signal,
    // Never the real home: OpenCode's configuration is written even without an OpenCode on the machine.
    environment: { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") },
  };
  return { ...fake, deps, store, path };
}

const self = (): FakePlugin => ({ id: "fleet-kit", source: SELF_SOURCE, version: "0.1.0", enabled: true, schema: {}, values: {} });
const notes = (overrides: Partial<FakePlugin> = {}): FakePlugin => ({
  id: "notes",
  source: NOTES_SOURCE,
  version: "1.0.0",
  enabled: true,
  schema: { greeting: { type: "string" }, token: { type: "string", secret: true }, allowedProviders: { type: "string" } },
  values: { greeting: "hello", allowedProviders: "corp" },
  ...overrides,
});
const pluginCalls = (calls: string[]) =>
  calls.filter((call) => !call.startsWith("settings") && call !== "check fleet-kit" && !call.startsWith("ai ") && !call.startsWith("agent "));
const callsOf = (calls: string[], prefix: string) => calls.filter((call) => call.startsWith(prefix));

describe("sync", () => {
  it("installs, configures, removes what removePlugins lists, and holds bb settings", async () => {
    const old: FakePlugin = { id: "old-thing", source: "npm:old-thing", version: "1.0.0", enabled: true, schema: {}, values: {} };
    const { deps, calls, general } = await setup(sampleManifest(), [self(), old]);
    const outcome = await runSync(deps, "start");
    expect(pluginCalls(calls)).toEqual(["install notes", "config notes allowedProviders,greeting", "remove old-thing"]);
    expect(general.telemetryEnabled).toBe(false);
    expect(general.streamerMode).toBe(false);
    expect(outcome.managed.plugins.notes).toEqual({ manifestSource: NOTES_SOURCE, bbSource: NOTES_SOURCE });
    const kinds = outcome.report.steps.map((step) => `${step.area}:${step.item}:${step.outcome}`);
    expect(kinds).toContain("plugin:later:skipped");
    expect(kinds).toContain("secret:gateway-key:warning");
    expect(kinds).toContain("opencode:OpenCode:warning");
    expect(outcome.report.build).toEqual({ name: "Example build", version: "1.2.0" });
    expect(outcome.selfUpdate).toBe(false);
  });

  it("is quiet on a second pass and applies an update the source offers", async () => {
    const first = await setup(sampleManifest(), [self()]);
    const outcome = await runSync(first.deps, "start");
    first.calls.length = 0;
    first.plugins.get("notes")!.update = "1.1.0";
    const second = await runSync({ ...first.deps, managed: outcome.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual(["update notes"]);
    expect(second.report.steps.find((step) => step.item === "notes")?.message).toBe("Updated to 1.1.0.");
  });

  it("reinstalls on a source change, keeps plain settings, and asks for secrets again", async () => {
    const existing = notes({ source: "git:https://git.example.test/plugins.git@semver:notes/:^0.9.0", version: "0.9.3", enabled: false, values: { greeting: "custom", token: "t" } });
    const { deps, calls, plugins } = await setup(sampleManifest(), [self(), existing]);
    const outcome = await runSync(deps, "manual");
    // Restore the old plain settings first, then apply the manifest's values.
    expect(pluginCalls(calls)).toEqual(["remove notes", "install notes", "config notes greeting", "config notes allowedProviders,greeting"]);
    expect(plugins.get("notes")!.values.greeting).toBe("hello");
    expect(outcome.notices.map((notice) => notice.kind)).toEqual(["reinstalled"]);
  });

  it("puts the previous source back when the new one does not install", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[1].source = "git:https://git.example.test/broken-notes.git@semver:notes/:^2.0.0";
    const previous = "git:https://git.example.test/plugins.git@semver:notes/:^0.9.0";
    const { deps, calls, plugins } = await setup(manifest, [self(), notes({ source: previous, values: { greeting: "custom" } })]);
    const outcome = await runSync(deps, "manual");
    expect(pluginCalls(calls).slice(0, 3)).toEqual(["remove notes", `install-failed ${manifest.plugins[1].source}`, "install notes"]);
    expect(plugins.get("notes")!.source).toBe(previous);
    expect(plugins.get("notes")!.values.greeting).toBe("custom");
    const step = outcome.report.steps.find((entry) => entry.item === "notes" && entry.outcome === "error");
    expect(step?.message).toContain("the previous source is back");
    expect(outcome.notices).toEqual([]);
  });

  it("enables a disabled plugin and never writes its secret settings", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[1].config = { greeting: "hello", token: "plain" };
    const { deps, calls } = await setup(manifest, [self(), notes({ enabled: false })]);
    const outcome = await runSync(deps, "manual");
    expect(pluginCalls(calls)).toEqual(["enable notes"]);
    expect(outcome.report.steps.some((step) => step.message.includes('"token" is a secret setting'))).toBe(true);
  });

  it("keeps a plugin the build no longer lists unless removePlugins names it", async () => {
    const first = await setup(sampleManifest(), [self()]);
    const outcome = await runSync(first.deps, "start");
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins = manifest.plugins.filter((plugin: any) => plugin.id !== "notes");
    await writeFile(first.path, JSON.stringify(manifest));
    first.calls.length = 0;
    const second = await runSync({ ...first.deps, managed: outcome.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual([]);
    expect(second.report.steps.find((step) => step.item === "notes")?.message).toContain("kept");
    expect(first.plugins.has("notes")).toBe(true);

    manifest.removePlugins = ["notes"];
    await writeFile(first.path, JSON.stringify(manifest));
    await runSync({ ...first.deps, managed: second.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual(["remove notes"]);
  });

  it("removes a plugin the build's branding replaces from the sync after the one that saved the branding", async () => {
    const first = await setup(sampleManifest(), [self()]);
    const outcome = await runSync(first.deps, "start");
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins = manifest.plugins.filter((plugin: any) => plugin.id !== "notes");
    manifest.branding = { appName: "Example", logoSvg: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", replaces: ["notes"] };
    await writeFile(first.path, JSON.stringify(manifest));
    first.calls.length = 0;
    const saved: string[] = [];
    const deps = { ...first.deps, onManifest: async (value: any) => void saved.push(value.branding?.appName) };
    // The sync that first sees the branding saves it and keeps the plugin: an open page has not read it yet.
    const second = await runSync({ ...deps, managed: outcome.managed }, "schedule");
    expect(saved).toEqual(["Example"]);
    expect(pluginCalls(first.calls)).toEqual([]);
    expect(first.plugins.has("notes")).toBe(true);
    // The next one removes it.
    const third = await runSync({ ...deps, managed: second.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual(["remove notes"]);
    expect(first.plugins.has("notes")).toBe(false);
    // A changed logo waits one sync again; without a branding nothing it named is removed.
    manifest.branding.appName = "Renamed";
    manifest.plugins.push({ id: "notes", source: "git:https://git.example.test/notes.git@semver:notes/:^1.0.0", status: "required" });
    manifest.branding.replaces = [];
    await writeFile(first.path, JSON.stringify(manifest));
    const fourth = await runSync({ ...deps, managed: third.managed }, "schedule");
    expect(fourth.managed.branding).toContain("Renamed");
  });

  it("never removes a plugin bundled with bb", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.removePlugins = ["bb-guide"];
    const bundled: FakePlugin = { id: "bb-guide", source: "builtin:bb-guide", version: "0.1.0", enabled: true, provenance: "builtin", schema: {}, values: {} };
    const { deps, calls } = await setup(manifest, [self(), notes(), bundled]);
    const outcome = await runSync(deps, "manual");
    expect(calls).not.toContain("remove bb-guide");
    expect(outcome.report.steps.find((step) => step.item === "bb-guide")?.outcome).toBe("warning");
  });

  it("removes a plugin a source installs under another id and reports it", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[1].source = "git:https://git.example.test/wrong.git@semver:notes/:^1.0.0";
    const { deps, calls, plugins } = await setup(manifest, [self()]);
    const outcome = await runSync(deps, "manual");
    expect(pluginCalls(calls)).toEqual(["install wrong", "remove wrong"]);
    expect(plugins.has("wrong")).toBe(false);
    expect(outcome.report.steps.find((step) => step.item === "notes")?.message).toContain('installs the plugin "wrong"');
  });

  it("applies nothing from a manifest with errors", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.allowedProviders = ["other"];
    const { deps, calls } = await setup(manifest, [self()]);
    const outcome = await runSync(deps, "manual");
    expect(pluginCalls(calls)).toEqual([]);
    expect(outcome.report.outcome).toBe("error");
    expect(outcome.manifest).toBeNull();
  });

  it("reports an unknown bb setting instead of sending it", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.bb.settings = { noSuchSetting: true };
    const { deps, calls } = await setup(manifest, [self()]);
    const outcome = await runSync(deps, "manual");
    expect(calls.some((call) => call.startsWith("settings"))).toBe(false);
    expect(outcome.report.steps.find((step) => step.item === "noSuchSetting")?.outcome).toBe("error");
  });
});

describe("programs plugins need (apps)", () => {
  const BOARD_SOURCE = "git:https://git.example.test/plugins.git@semver:board/:^1.0.0";
  const part = { url: "https://files.example.test/office.zip.part-aa", sha256: "a".repeat(64) };
  function withApp(extra: Record<string, unknown> = {}) {
    const manifest = sampleManifest() as any;
    manifest.plugins.push({ id: "board", source: BOARD_SOURCE, plugin: "board", status: "required" });
    manifest.apps = [
      {
        id: "office",
        title: "Office",
        version: "26.8.2",
        plugin: "notes",
        setting: "officePath",
        before: "board",
        files: { "win32-x64": { format: "zip", parts: [part], sha256: "b".repeat(64), program: "Office/program/soffice.exe" } },
        ...extra,
      },
    ];
    return manifest;
  }
  async function prepared(manifest: Record<string, unknown>, outcome: any = { state: "installed", path: "C:\\Users\\p\\apps\\office\\26.8.2\\Office\\program\\soffice.exe" }) {
    const env = await setup(manifest, [self()]);
    const asked: any[] = [];
    env.deps.settings = { ...env.deps.settings, opencodeInstallDir: join(tmpdir(), "x5", "runtime", "opencode") };
    env.deps.machine = "win32-x64";
    env.deps.ensureApp = async (input) => {
      asked.push(input);
      env.calls.push(`app ${input.version}`);
      return typeof outcome === "function" ? outcome(input) : outcome;
    };
    return { ...env, asked };
  }

  it("installs after its plugin, before the plugin named in before, and writes the path to the plugin's setting", async () => {
    const env = await prepared(withApp());
    const outcome = await runSync(env.deps, "start");
    expect(pluginCalls(env.calls)).toEqual(["install notes", "config notes allowedProviders,greeting", "app 26.8.2", "config notes officePath", "install board"]);
    expect(env.plugins.get("notes")!.values.officePath).toContain("soffice.exe");
    expect(env.asked[0].directory).toBe(join(tmpdir(), "x5", "runtime", "apps", "office"));
    expect(env.asked[0].file.parts).toEqual([part]);
    expect(outcome.report.steps.find((step) => step.area === "app")).toMatchObject({ item: "Office", outcome: "changed", code: "appInstalled" });
  });

  it("is quiet when the program is in place and the path already set", async () => {
    const env = await prepared(withApp(), { state: "current", path: "C:\\p\\soffice.exe" });
    await runSync(env.deps, "start");
    env.calls.length = 0;
    const outcome = await runSync({ ...env.deps, managed: (await runSync(env.deps, "start")).managed }, "schedule");
    expect(callsOf(env.calls, "config notes officePath")).toEqual([]);
    expect(outcome.report.steps.find((step) => step.area === "app")).toMatchObject({ outcome: "ok" });
  });

  it("goes after all plugins without before", async () => {
    const env = await prepared(withApp({ before: undefined }));
    await runSync(env.deps, "start");
    const order = pluginCalls(env.calls);
    expect(order.indexOf("app 26.8.2")).toBeGreaterThan(order.indexOf("install board"));
  });

  it("is not installed while its plugin is off here, nor on a machine the build has no package for", async () => {
    const off = withApp();
    off.branches = { common: [], optional: [{ id: "notes", title: "Notes" }], list: [{ id: "lean", title: "Lean", plugins: { notes: false } }] };
    const env = await prepared(off);
    const outcome = await runSync({ ...env.deps, choice: { branch: "lean", plugins: {}, at: "2026-11-08T00:00:00.000Z" } }, "start");
    expect(callsOf(env.calls, "app")).toEqual([]);
    expect(outcome.report.steps.find((step) => step.area === "app")).toMatchObject({ outcome: "skipped", code: "appPluginOff" });

    const mac = await prepared(withApp());
    mac.deps.machine = "darwin-arm64";
    const other = await runSync(mac.deps, "start");
    expect(callsOf(mac.calls, "app")).toEqual([]);
    expect(other.report.steps.find((step) => step.area === "app")).toMatchObject({ outcome: "skipped", code: "appNotForMachine" });
  });

  it("needs a folder: without appsInstallDir or opencodeInstallDir it warns and installs nothing", async () => {
    const env = await prepared(withApp());
    env.deps.settings = { ...env.deps.settings, opencodeInstallDir: "" };
    const outcome = await runSync(env.deps, "start");
    expect(callsOf(env.calls, "app")).toEqual([]);
    expect(outcome.report.steps.find((step) => step.area === "app")).toMatchObject({ outcome: "warning", code: "appNoFolder" });
  });

  it("stops downloading after three failures in a row, until a sync the person starts", async () => {
    const env = await prepared(withApp(), (input: any) => (input.mayDownload === false ? { state: "failed", reason: "paused", detail: "" } : { state: "failed", reason: "download", detail: "HTTP 500" }));
    let managed = env.deps.managed;
    const allowed: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      const outcome = await runSync({ ...env.deps, managed }, "schedule");
      managed = outcome.managed;
      allowed.push(env.asked.at(-1).mayDownload);
    }
    expect(allowed).toEqual([true, true, true, false]);
    expect(managed.appFailures?.office?.count).toBe(3);
    await runSync({ ...env.deps, managed }, "manual");
    expect(env.asked.at(-1).mayDownload).toBe(true);
  });
});

describe("Fleet Kit's own update", () => {
  it("still updates itself from a manifest in a newer format, and applies nothing else", async () => {
    const manifest = { ...clone(sampleManifest()), schema: 2, newSection: { anything: true } };
    const { deps, calls } = await setup(manifest, [{ ...self(), update: "0.2.0" }]);
    const outcome = await runSync(deps, "start");
    expect(outcome.selfUpdate).toBe(true);
    expect(outcome.report.fleetKitOutdated).toBe(true);
    expect(pluginCalls(calls)).toEqual([]);
    expect(outcome.managed.selfUpdate).toMatchObject({ version: "0.2.0", attempts: 1 });
  });

  it("tries the same version at most twice a day", async () => {
    let now = Date.parse("2026-10-31T10:00:00Z");
    const first = await setup(sampleManifest(), [{ ...self(), update: "0.2.0" }]);
    const deps = { ...first.deps, now: () => now };
    const one = await runSync(deps, "start");
    expect(one.selfUpdate).toBe(true);
    // The update rolled back: the old version runs again and is offered the same one.
    now += 60_000;
    const two = await runSync({ ...deps, managed: one.managed }, "start");
    expect(two.selfUpdate).toBe(true);
    now += 60_000;
    const three = await runSync({ ...deps, managed: two.managed }, "start");
    expect(three.selfUpdate).toBe(false);
    expect(three.report.steps.find((step) => step.item === "fleet-kit")?.message).toContain("did not install after 2 tries");
    now += 25 * 60 * 60 * 1000;
    const nextDay = await runSync({ ...deps, managed: three.managed }, "schedule");
    expect(nextDay.selfUpdate).toBe(true);
    expect(nextDay.managed.selfUpdate?.attempts).toBe(1);
  });

  it("does not update itself from a source without @semver: or @ref:", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[0].source = "git:https://git.example.test/plugins.git";
    const { deps, calls } = await setup(manifest, [{ ...self(), source: manifest.plugins[0].source, update: "0.2.0" }]);
    const outcome = await runSync(deps, "start");
    expect(outcome.selfUpdate).toBe(false);
    expect(calls).not.toContain("check fleet-kit");
    expect(outcome.report.steps.find((step) => step.item === "fleet-kit")?.message).toContain("not pinned");
  });
});

describe("switching a plugin's source", () => {
  const BROKEN = "git:https://git.example.test/broken-notes.git@semver:notes/:^2.0.0";
  const SLOW = "git:https://git.example.test/slow-notes.git@semver:notes/:^2.0.0";
  const PREVIOUS = "git:https://git.example.test/plugins.git@semver:notes/:^0.9.0";
  const withSource = (source: string) => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[1].source = source;
    return manifest;
  };
  const message = (outcome: Awaited<ReturnType<typeof runSync>>) => outcome.report.steps.filter((step) => step.item === "notes").map((step) => step.message).join(" | ");

  it("tries at most twice a day, an hour apart, and leaves the previous source alone between tries", async () => {
    let now = Date.parse("2026-10-31T10:00:00Z");
    const first = await setup(withSource(BROKEN), [self(), notes({ source: PREVIOUS, values: { greeting: "custom" } })]);
    const deps = { ...first.deps, now: () => now };
    const one = await runSync(deps, "manual");
    expect(pluginCalls(first.calls).slice(0, 3)).toEqual(["remove notes", `install-failed ${BROKEN}`, "install notes"]);
    expect(one.managed.sourceChanges.notes).toMatchObject({ target: BROKEN, attempts: 1, pending: false });

    // The next sync: nothing removed, installed or configured.
    first.calls.length = 0;
    now += 5 * 60_000;
    const two = await runSync({ ...deps, managed: one.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual([]);
    expect(first.plugins.get("notes")!.source).toBe(PREVIOUS);
    expect(message(two)).toContain("Kept on its previous source");

    // An hour after the first try: the second one.
    now = Date.parse("2026-10-31T11:00:01Z");
    const three = await runSync({ ...deps, managed: two.managed }, "schedule");
    expect(pluginCalls(first.calls).slice(0, 3)).toEqual(["remove notes", `install-failed ${BROKEN}`, "install notes"]);
    expect(three.managed.sourceChanges.notes?.attempts).toBe(2);

    // Both tries used: none until a day after the first.
    first.calls.length = 0;
    now = Date.parse("2026-10-31T20:00:00Z");
    const four = await runSync({ ...deps, managed: three.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual([]);
    expect(four.report.steps.find((step) => step.item === "notes")).toMatchObject({ code: "switchWaiting", params: { attempts: 2, next: "2026-11-01T10:00:00.000Z" } });

    now = Date.parse("2026-11-01T10:00:01Z");
    const five = await runSync({ ...deps, managed: four.managed }, "schedule");
    expect(pluginCalls(first.calls)[0]).toBe("remove notes");
    expect(five.managed.sourceChanges.notes?.attempts).toBe(1);
  });

  it("puts the previous source back with its subdirectory and asks for secrets again", async () => {
    const existing = notes({ source: PREVIOUS, subdirectory: "plugins/notes", values: { greeting: "custom", token: "t" } });
    const { deps, installs, plugins } = await setup(withSource(BROKEN), [self(), existing]);
    const outcome = await runSync(deps, "manual");
    expect(installs.at(-1)).toEqual({ source: PREVIOUS, subdirectory: "plugins/notes" });
    expect(plugins.get("notes")!.source).toBe(PREVIOUS);
    expect(plugins.get("notes")!.values.greeting).toBe("custom");
    expect(outcome.notices).toHaveLength(1);
    expect(outcome.notices[0]!.message).toContain("put back on the previous one. Enter its secret settings again.");
  });

  it("waits for a timed-out install instead of installing a second source", async () => {
    const first = await setup(withSource(SLOW), [self(), notes({ source: PREVIOUS, values: { greeting: "custom", token: "t" } })]);
    const deps = { ...first.deps, installMs: 20 };
    const one = await runSync(deps, "manual");
    expect(pluginCalls(first.calls)).toEqual(["remove notes", "install-started notes"]);
    expect(one.managed.sourceChanges.notes?.pending).toBe(true);
    expect(message(one)).toContain("still installing");

    first.calls.length = 0;
    const two = await runSync({ ...deps, managed: one.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual([]);
    expect(message(two)).toContain("still installing");

    // bb finishes the install it was given; the next sync takes it as the switch.
    first.slow[0]!.finish();
    const three = await runSync({ ...deps, managed: two.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual(["config notes greeting", "config notes allowedProviders,greeting"]);
    expect(three.managed.sourceChanges.notes).toBeUndefined();
    expect(three.managed.plugins.notes).toEqual({ manifestSource: SLOW, bbSource: SLOW });
    expect(three.notices.map((notice) => notice.kind)).toEqual(["reinstalled"]);
  });

  it("puts the previous source back once a timed-out install is gone without a result", async () => {
    let now = Date.parse("2026-10-31T10:00:00Z");
    const first = await setup(withSource(SLOW), [self(), notes({ source: PREVIOUS, values: { greeting: "custom" } })]);
    const deps = { ...first.deps, installMs: 20, now: () => now };
    const one = await runSync(deps, "manual");
    // The job ends without installing anything.
    first.slow.splice(0);
    first.calls.length = 0;
    now += 5 * 60_000;
    const two = await runSync({ ...deps, managed: one.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual(["install notes", "config notes greeting"]);
    expect(first.plugins.get("notes")!.source).toBe(PREVIOUS);
    expect(two.managed.sourceChanges.notes).toMatchObject({ attempts: 1, pending: false });
    expect(message(two)).toContain("Put back on its previous source");
  });
});

describe("unfinished installs", () => {
  const SLOW = "git:https://git.example.test/slow-notes.git@semver:notes/:^2.0.0";
  const BROKEN = "git:https://git.example.test/broken-notes.git@semver:notes/:^2.0.0";
  const PREVIOUS = "git:https://git.example.test/plugins.git@semver:notes/:^0.9.0";
  const build = (edit: (notes: Record<string, any>, manifest: Record<string, any>) => void) => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    edit(manifest.plugins[1], manifest);
    return manifest;
  };
  const notesSteps = (outcome: Awaited<ReturnType<typeof runSync>>) => outcome.report.steps.filter((step) => step.item === "notes").map((step) => step.message).join(" | ");

  it.each([
    ["dropped from the build", (manifest: Record<string, any>) => { manifest.plugins.splice(1, 1); }],
    ["marked planned", (manifest: Record<string, any>) => { manifest.plugins[1].status = "planned"; }],
  ])("puts the previous source back when a timed-out switch is %s", async (_, edit) => {
    const first = await setup(build((notes) => { notes.source = SLOW; }), [self(), notes({ source: PREVIOUS, values: { greeting: "custom", token: "t" } })]);
    const deps = { ...first.deps, installMs: 20 };
    const one = await runSync(deps, "manual");
    expect(one.managed.sourceChanges.notes?.pending).toBe(true);
    await writeFile(first.path, JSON.stringify(build((_notes, manifest) => edit(manifest))));

    // Still installing: nothing else is started.
    first.calls.length = 0;
    const two = await runSync({ ...deps, managed: one.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual([]);
    expect(notesSteps(two)).toContain("still installing");

    // The job ends without a result: the previous source comes back, with the notice.
    first.slow.splice(0);
    const three = await runSync({ ...deps, managed: two.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual(["install notes", "config notes greeting"]);
    expect(first.plugins.get("notes")!.source).toBe(PREVIOUS);
    expect(three.managed.sourceChanges.notes).toBeUndefined();
    expect(three.notices.map((notice) => notice.message).join(" ")).toContain("Enter its secret settings again");
    expect(notesSteps(three)).toContain("put back on its previous source");
  });

  it("drops a finished switch's record when the plugin leaves the build", async () => {
    const first = await setup(build((notes) => { notes.source = BROKEN; }), [self(), notes({ source: PREVIOUS })]);
    const one = await runSync(first.deps, "manual");
    expect(one.managed.sourceChanges.notes).toMatchObject({ pending: false });
    await writeFile(first.path, JSON.stringify(build((_notes, manifest) => { manifest.plugins.splice(1, 1); })));
    first.calls.length = 0;
    const two = await runSync({ ...first.deps, managed: one.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual([]);
    expect(two.managed.sourceChanges.notes).toBeUndefined();
    expect(first.plugins.get("notes")!.source).toBe(PREVIOUS);
  });

  it("waits after a timed-out first install, also when bb's job list cannot be read", async () => {
    const first = await setup(build((notes) => { notes.source = SLOW; }), [self()]);
    const deps = { ...first.deps, installMs: 20 };
    const one = await runSync(deps, "start");
    expect(pluginCalls(first.calls)).toEqual(["install-started notes"]);
    expect(one.managed.installs.notes).toMatchObject({ source: SLOW });

    first.calls.length = 0;
    first.jobs.unavailable = true;
    const two = await runSync({ ...deps, managed: one.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual([]);
    expect(notesSteps(two)).toContain("Could not see whether bb is still installing it");

    // bb finishes the install it was given; the record goes.
    first.slow[0]!.finish();
    const three = await runSync({ ...deps, managed: two.managed }, "schedule");
    expect(pluginCalls(first.calls)).toEqual(["config notes allowedProviders,greeting"]);
    expect(three.managed.installs.notes).toBeUndefined();
  });

  it("installs when the job list cannot be read but nothing of its own is pending", async () => {
    const first = await setup(sampleManifest(), [self()]);
    first.jobs.unavailable = true;
    await runSync(first.deps, "start");
    expect(pluginCalls(first.calls)[0]).toBe("install notes");
  });
});

describe("Fleet Kit's own update while one runs", () => {
  it("neither counts a try nor starts a second update", async () => {
    const first = await setup(sampleManifest(), [{ ...self(), update: "0.2.0" }]);
    const one = await runSync(first.deps, "start");
    expect(one.selfUpdate).toBe(true);

    first.updateJobs.push({ id: "update_1", pluginId: "fleet-kit", state: "running" });
    const two = await runSync({ ...first.deps, managed: one.managed }, "manual");
    expect(two.selfUpdate).toBe(false);
    expect(two.managed.selfUpdate?.attempts).toBe(1);
    expect(two.report.steps.find((step) => step.item === "fleet-kit")?.message).toContain("already running");

    // bb has not listed the job yet, but this process started it a minute ago.
    first.updateJobs.length = 0;
    const three = await runSync({ ...first.deps, managed: two.managed, selfUpdateStartedAt: Date.now() - 60_000 }, "manual");
    expect(three.selfUpdate).toBe(false);
    expect(three.managed.selfUpdate?.attempts).toBe(1);
  });
});

describe("bb's AI services", () => {
  const withAi = (aiServices: Record<string, unknown>) => ({ ...clone(sampleManifest()), aiServices });

  it("holds each task at the manifest's choice and never falls back to automatic", async () => {
    const first = await setup(withAi({ "thread-title": "off", "commit-message": "off", voice: "local-voice" }), [self()]);
    const one = await runSync(first.deps, "start");
    // The voice service is not registered yet: off, with a warning.
    expect(callsOf(first.calls, "ai ")).toEqual(["ai thread-title off", "ai commit-message off", "ai voice off"]);
    expect(one.report.steps.find((step) => step.item === "voice")).toMatchObject({ outcome: "warning", code: "aiServiceMissing" });

    first.calls.length = 0;
    await runSync({ ...first.deps, managed: one.managed }, "schedule");
    expect(callsOf(first.calls, "ai ")).toEqual([]);

    // The local voice plugin registers its service: the next sync selects it.
    first.ai.services.push({ id: "local-voice", displayName: "Local voice", pluginId: "voice-local", tasks: ["voice"], automaticRank: null, status: { ready: true } });
    const three = await runSync({ ...first.deps, managed: one.managed }, "schedule");
    expect(callsOf(first.calls, "ai ")).toEqual(["ai voice voice-local/local-voice"]);
    expect(three.report.steps.find((step) => step.item === "voice")).toMatchObject({ outcome: "changed", code: "aiService" });

    // Changed by hand: put back.
    first.calls.length = 0;
    first.ai.selections["thread-title"] = { mode: "automatic" };
    await runSync({ ...first.deps, managed: one.managed }, "schedule");
    expect(callsOf(first.calls, "ai ")).toEqual(["ai thread-title off"]);
  });

  it("asks for the plugin when several register the service", async () => {
    const first = await setup(withAi({ voice: "whisper" }), [self()]);
    for (const pluginId of ["voice-a", "voice-b"]) {
      first.ai.services.push({ id: "whisper", displayName: "Whisper", pluginId, tasks: ["voice"], automaticRank: null, status: { ready: true } });
    }
    const one = await runSync(first.deps, "start");
    expect(callsOf(first.calls, "ai ")).toEqual(["ai voice off"]);
    expect(one.report.steps.find((step) => step.item === "voice")).toMatchObject({ code: "aiServiceAmbiguous" });

    await writeFile(first.path, JSON.stringify(withAi({ voice: { service: "whisper", plugin: "voice-b" } })));
    first.calls.length = 0;
    await runSync({ ...first.deps, managed: one.managed }, "schedule");
    expect(callsOf(first.calls, "ai ")).toEqual(["ai voice voice-b/whisper"]);
  });

  it("leaves bb's AI services alone without the block", async () => {
    const { deps, calls } = await setup(sampleManifest(), [self()]);
    await runSync(deps, "start");
    expect(callsOf(calls, "ai ")).toEqual([]);
  });
});

describe("bb agents", () => {
  const withAgents = (allowed: string[]) => ({ ...clone(sampleManifest()), agents: { allowed } });

  it("turns off every agent but the allowed ones, and says so once when one is turned on again", async () => {
    const first = await setup(withAgents(["acp-opencode"]), [self()]);
    const one = await runSync(first.deps, "start");
    expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off", "agent claude-code off"]);
    expect(one.notices).toEqual([]);
    expect(one.managed.agents.disabled.sort()).toEqual(["claude-code", "codex", "cursor"]);

    first.calls.length = 0;
    const two = await runSync({ ...first.deps, managed: one.managed }, "schedule");
    expect(callsOf(first.calls, "agent ")).toEqual([]);

    // The person turns Codex on: off again, with one notice.
    first.agents.find((entry) => entry.id === "codex")!.enabled = true;
    const three = await runSync({ ...first.deps, managed: two.managed }, "schedule");
    expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off"]);
    expect(three.notices).toHaveLength(1);
    expect(three.notices[0]).toMatchObject({ id: "agent-disabled:codex", kind: "agent-disabled", code: "noticeAgentDisabled", params: { agent: "Codex", allowed: "OpenCode" } });
    expect(three.report.steps.find((step) => step.item === "Codex")).toMatchObject({ outcome: "warning", code: "agentDisabledAgain" });
  });

  describe("own agents", () => {
    const withOwn = () => ({ ...withAgents(["acp-opencode"]), ownAgents: { providers: ["codex", "claude-code"], warning: "Your agent reads what this bb holds." } });
    const on = { on: true, at: "2026-11-07T10:00:00.000Z", key: consentKey(withOwn().ownAgents) };

    it("turns them off like any other agent until the person turns them on", async () => {
      const first = await setup(withOwn(), [self()]);
      await runSync({ ...first.deps, ownAgents: null }, "start");
      expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off", "agent claude-code off"]);
      first.calls.length = 0;
      first.agents.find((entry) => entry.id === "codex")!.enabled = true;
      await runSync({ ...first.deps, ownAgents: { on: false, at: on.at } }, "schedule");
      expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off"]);
    });

    it("once on, neither turns them off nor on, and still turns off the rest", async () => {
      const first = await setup(withOwn(), [self()]);
      const one = await runSync({ ...first.deps, ownAgents: on }, "start");
      // Codex was on and stays on; Claude Code cannot run here and is left as it is; Cursor stays off.
      expect(callsOf(first.calls, "agent ")).toEqual([]);
      expect(one.managed.agents.disabled).toEqual(["cursor"]);
      first.agents.find((entry) => entry.id === "cursor")!.enabled = true;
      first.agents.find((entry) => entry.id === "codex")!.enabled = false;
      first.calls.length = 0;
      const two = await runSync({ ...first.deps, managed: one.managed, ownAgents: on }, "schedule");
      expect(callsOf(first.calls, "agent ")).toEqual(["agent cursor off"]);
      expect(two.notices.map((notice) => notice.id)).toEqual(["agent-disabled:cursor"]);
    });

    it("turns them off again when the person turns own agents off, without a 'turned on by hand' notice", async () => {
      const first = await setup(withOwn(), [self()]);
      const one = await runSync({ ...first.deps, ownAgents: on }, "start");
      first.calls.length = 0;
      const two = await runSync({ ...first.deps, managed: one.managed, ownAgents: { on: false, at: "2026-11-07T11:00:00.000Z" } }, "schedule");
      expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off", "agent claude-code off"]);
      expect(two.notices).toEqual([]);
      expect(two.report.steps.find((step) => step.item === "Codex")).toMatchObject({ outcome: "changed", code: "agentDisabled" });
    });

    it("ignores the person's switch when the build offers no own agents", async () => {
      const first = await setup(withAgents(["acp-opencode"]), [self()]);
      await runSync({ ...first.deps, ownAgents: on }, "start");
      expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off", "agent claude-code off"]);
    });
  });

  it("turns an allowed agent back on", async () => {
    const first = await setup(withAgents(["acp-opencode"]), [self()]);
    first.agents.find((entry) => entry.id === "acp-opencode")!.enabled = false;
    await runSync(first.deps, "start");
    expect(callsOf(first.calls, "agent ")).toContain("agent acp-opencode on");
  });

  it("turns the other agents off even while the allowed agent cannot run (OpenCode not installed)", async () => {
    const first = await setup(withAgents(["acp-opencode"]), [self()]);
    first.agents.find((entry) => entry.id === "acp-opencode")!.available = false;
    const one = await runSync(first.deps, "start");
    expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off", "agent claude-code off"]);
    expect(one.report.steps.find((step) => step.code === "agentUnavailable")).toMatchObject({ outcome: "warning", item: "OpenCode" });
    expect(one.report.steps.find((step) => step.item === "agents")).toMatchObject({ outcome: "error", code: "agentsNoneReady" });
    expect(first.agents.filter((entry) => entry.enabled).map((entry) => entry.id)).toEqual(["acp-opencode"]);
  });

  it("OpenCode not ready and Codex turned on without the person's yes: Codex is turned off", async () => {
    const first = await setup({ ...withAgents(["acp-opencode"]), ownAgents: { providers: ["codex"], warning: "Your agent reads what this bb holds." } }, [self()]);
    Object.assign(first.agents.find((entry) => entry.id === "acp-opencode")!, { enabled: false, available: false });
    await runSync({ ...first.deps, ownAgents: null }, "start");
    expect(callsOf(first.calls, "agent ")).toContain("agent codex off");
    expect(first.agents.find((entry) => entry.id === "codex")!.enabled).toBe(false);
  });

  it("does not try to turn on an allowed agent whose plugin is off, still turns the others off, and does not repeat on the next sync", async () => {
    const first = await setup(withAgents(["acp-opencode"]), [self()]);
    const opencode = first.agents.find((entry) => entry.id === "acp-opencode")!;
    Object.assign(opencode, { enabled: false, pluginEnabled: false });
    const one = await runSync(first.deps, "start");
    expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off", "agent claude-code off"]);
    expect(one.report.steps.find((step) => step.code === "agentPluginOff")).toMatchObject({ outcome: "warning", item: "OpenCode" });
    expect(one.report.steps.find((step) => step.item === "agents")).toMatchObject({ outcome: "error", code: "agentsNoneReady" });
    first.calls.length = 0;
    const two = await runSync({ ...first.deps, managed: one.managed }, "schedule");
    expect(callsOf(first.calls, "agent ")).toEqual([]);
    expect(two.report.outcome).toBe("error");

    // Its plugin is on again: the next sync turns it on.
    opencode.pluginEnabled = true;
    await runSync({ ...first.deps, managed: two.managed }, "schedule");
    expect(callsOf(first.calls, "agent ")).toEqual(["agent acp-opencode on"]);
  });

  it("still tries to turn the others off when bb refuses to turn the allowed agent on", async () => {
    const first = await setup(withAgents(["acp-opencode"]), [self()]);
    first.agents.find((entry) => entry.id === "acp-opencode")!.enabled = false;
    first.deps.sdk.providers.setEnabled = (async ({ providerId, enabled }: { providerId: string; enabled: boolean }) => {
      first.calls.push(`agent ${providerId} ${enabled ? "on" : "off"}`);
      if (enabled) throw new Error("Provider is unavailable (provider_unavailable)");
      first.agents.find((entry) => entry.id === providerId)!.enabled = false;
      return clone(first.agents);
    }) as never;
    const one = await runSync(first.deps, "start");
    // The early pass turns the others off before plugins install; the later one tries the allowed agent.
    expect(callsOf(first.calls, "agent ")).toEqual(["agent codex off", "agent claude-code off", "agent acp-opencode on"]);
    expect(one.report.steps.find((step) => step.item === "agents")).toMatchObject({ outcome: "error", code: "agentsNoneReady" });
    expect(first.agents.filter((entry) => entry.enabled).map((entry) => entry.id)).toEqual([]);
  });

  it("an error in the AI service or agent step does not stop the rest of the sync", async () => {
    const first = await setup({ ...withAgents(["acp-opencode"]), aiServices: { voice: "off" } }, [self()]);
    first.deps.sdk.system.aiServices = async () => {
      throw new Error("ai boom");
    };
    first.deps.sdk.providers.catalog = async () => {
      throw new Error("agents boom");
    };
    const outcome = await runSync(first.deps, "start");
    expect(outcome.report.steps.find((step) => step.item === "ai-services")).toMatchObject({ outcome: "error", message: "ai boom" });
    expect(outcome.report.steps.find((step) => step.item === "agents")).toMatchObject({ outcome: "error", message: "agents boom" });
    expect(outcome.report.steps.some((step) => step.area === "opencode")).toBe(true);
  });

  it("turns the other agents off and reports an error when none of the allowed agents exists here", async () => {
    const first = await setup(withAgents(["acp-missing"]), [self()]);
    const outcome = await runSync(first.deps, "start");
    expect(callsOf(first.calls, "agent ")).toEqual(["agent acp-opencode off", "agent codex off", "agent claude-code off"]);
    expect(outcome.report.steps.find((step) => step.item === "agents")).toMatchObject({ outcome: "error", code: "agentsNoneHere" });
  });
});

describe("OpenCode installed by Fleet Kit", () => {
  const acp = (values: Record<string, unknown> = {}): FakePlugin => ({ id: "provider-acp", source: "builtin:provider-acp", version: "1.0.0", enabled: true, provenance: "builtin", schema: { customAgents: { type: "string" } }, values });
  const withInstall = () => ({
    ...sampleManifest(),
    aiServices: { "thread-title": "off" },
    opencodeInstall: { files: { "linux-x64": { url: "https://files.example.test/o.tgz", integrity: `sha512-${"A".repeat(86)}==`, entry: "package/bin/opencode" } }, notReadyMessage: "wait please" },
  });

  async function prepare(result: (directory: string) => InstallOutcome, texts: Record<string, string> = {}) {
    const manifest = withInstall();
    Object.assign(manifest.opencodeInstall, texts);
    const first = await setup(manifest, [self(), acp()]);
    const installDir = join(first.deps.environment.HOME!, "own");
    const order: string[] = [];
    let configAtInstall = "";
    let agentAtInstall = "";
    first.deps.settings.opencodeInstallDir = installDir;
    first.deps.agentRuntime = { execPath: "/app", electron: true };
    first.deps.ensureOpenCode = async () => {
      order.push(`install after: ${pluginCalls(first.calls).join(",")}`);
      configAtInstall = await readFile(join(first.deps.environment.HOME!, ".config", "opencode", "opencode.json"), "utf8");
      const settings = await first.sdk.plugins.getSettings({ pluginId: "provider-acp" });
      agentAtInstall = String(settings.values.customAgents);
      return result(installDir);
    };
    return { ...first, installDir, order, config: () => configAtInstall, agent: () => agentAtInstall };
  }

  it("stops fetching after three failures in a row, until later or until the person asks", async () => {
    const run = await prepare((directory) => ({ state: "failed", reason: "download", path: join(directory, "opencode"), detail: "offline" }));
    const allowed: boolean[] = [];
    const inner = run.deps.ensureOpenCode!;
    run.deps.ensureOpenCode = async (files, directory, version, mayDownload) => {
      allowed.push(mayDownload);
      return mayDownload ? inner(files, directory, version, mayDownload) : { state: "failed", reason: "paused", path: join(directory, "opencode"), detail: "" };
    };
    let now = 1_000_000;
    run.deps.now = () => now;
    const once = async (trigger: "schedule" | "manual") => {
      const outcome = await runSync(run.deps, trigger);
      run.deps.managed = outcome.managed;
      return outcome;
    };
    expect((await once("schedule")).retrySoon).toBe(true);
    expect((await once("schedule")).retrySoon).toBe(true);
    expect((await once("schedule")).retrySoon).toBe(false);
    const paused = await once("schedule");
    expect(paused.retrySoon).toBe(false);
    expect(paused.report.steps.some((step) => step.code === "opencodeInstallPaused")).toBe(true);
    expect(allowed).toEqual([true, true, true, false]);
    await once("manual");
    expect(allowed[4]).toBe(true);
    now += 7 * 60 * 60_000;
    await once("schedule");
    expect(allowed[5]).toBe(true);
  });

  it("does not retry soon what a retry cannot help", async () => {
    for (const reason of ["no-file", "broken", "denied"] as const) {
      const run = await prepare((directory) => ({ state: "failed", reason, path: join(directory, "opencode"), detail: "x" }));
      expect((await runSync(run.deps, "schedule")).retrySoon).toBe(false);
    }
  });

  it("tells the wrapper what to say when installing has stopped or is refused", async () => {
    const stopped = await prepare((directory) => ({ state: "failed", reason: "no-file", path: join(directory, "opencode"), detail: "x" }));
    await runSync(stopped.deps, "schedule");
    expect(JSON.parse(await readFile(join(stopped.installDir, "bb-acp-state.json"), "utf8")).message).not.toBe(null);
    const passing = await prepare((directory) => ({ state: "failed", reason: "download", path: join(directory, "opencode"), detail: "x" }));
    await runSync(passing.deps, "schedule");
    expect(JSON.parse(await readFile(join(passing.installDir, "bb-acp-state.json"), "utf8").catch(() => '{"message":null}')).message).toBe(null);
  });

  it("an exception on the way is a failed install with a retry, and the plugins still go on", async () => {
    const run = await prepare(() => {
      throw new Error("disk gone");
    });
    const outcome = await runSync(run.deps, "schedule");
    expect(outcome.opencode?.install?.state).toBe("failed");
    expect(outcome.opencode?.install?.message).toContain("disk gone");
    expect(outcome.retrySoon).toBe(true);
    expect(pluginCalls(run.calls).some((call) => call.includes("notes"))).toBe(true);
  });

  it("settings that cannot be written leave a failed install and no OpenCode", async () => {
    const run = await prepare((directory) => ({ state: "current", path: join(directory, "opencode"), version: "2.2.5" }));
    let installs = 0;
    run.deps.ensureOpenCode = async (_files, directory) => {
      installs += 1;
      return { state: "current", path: join(directory, "opencode"), version: "2.2.5" };
    };
    const blocked = join(run.deps.environment.HOME!, ".config");
    await rm(blocked, { recursive: true, force: true });
    await writeFile(blocked, "a file where the folder should go");
    const outcome = await runSync(run.deps, "schedule");
    expect(installs).toBe(0);
    expect(outcome.opencode?.install?.state).toBe("failed");
    expect(outcome.report.steps.some((step) => step.area === "opencode" && step.outcome === "error")).toBe(true);
    expect(outcome.retrySoon).toBe(true);
  });

  describe("settings and the agent entry", () => {
    const ready = (directory: string): InstallOutcome => ({ state: "current", path: join(directory, "opencode"), version: "2.2.5" });
    const stateFile = (run: { installDir: string }) => join(run.installDir, "bb-acp-state.json");
    const breakConfig = async (run: { deps: { environment: Record<string, string | undefined> } }) => {
      const dir = join(run.deps.environment.HOME!, ".config", "opencode");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "opencode.json"), "{");
    };
    const again = async (run: Awaited<ReturnType<typeof prepare>>, trigger: "schedule" | "manual" = "schedule") => {
      const outcome = await runSync(run.deps, trigger);
      run.deps.managed = outcome.managed;
      return outcome;
    };

    it("a broken config: failed, the wrapper is told and registered, nothing installed, and it clears once the file is good", async () => {
      const run = await prepare(ready, { configFailedMessage: "Настройки не записаны: {error}" });
      let installs = 0;
      const inner = run.deps.ensureOpenCode!;
      run.deps.ensureOpenCode = async (...args) => {
        installs += 1;
        return inner(...args);
      };
      await breakConfig(run);
      const failed = await again(run);
      expect(failed.opencode?.install?.state).toBe("failed");
      expect(installs).toBe(0);
      const saved = JSON.parse(await readFile(stateFile(run), "utf8"));
      expect(saved.blocked).toBe(true);
      expect(saved.message).toMatch(/^Настройки не записаны: ./);
      const entry = JSON.parse(String((await run.sdk.plugins.getSettings({ pluginId: "provider-acp" })).values.customAgents)).find((one: { id: string }) => one.id === "opencode");
      expect(entry.env.ACP_SHIM_CONFIG).toContain("opencode.json");
      expect(entry.env.ACP_SHIM_CONFIG_FAILED).toMatch(/^Настройки не записаны: ./);
      await writeFile(join(run.deps.environment.HOME!, ".config", "opencode", "opencode.json"), "{}");
      const fixed = await again(run);
      expect(fixed.opencode?.install?.state).toBe("ready");
      expect(installs).toBe(1);
      const after = JSON.parse(await readFile(stateFile(run), "utf8"));
      expect(after.blocked).toBe(false);
      expect(after.message).toBe(null);
      expect(fixed.managed.opencodeSetupFailures).toBe(null);
    });

    it("a config that keeps failing stops the timer after three; a sync the person starts brings it back", async () => {
      const run = await prepare(ready);
      await breakConfig(run);
      expect((await again(run)).retrySoon).toBe(true);
      expect((await again(run)).retrySoon).toBe(true);
      const third = await again(run);
      expect(third.retrySoon).toBe(false);
      expect(third.opencode?.install?.code).toBe("opencodeConfigStopped");
      expect((await again(run)).retrySoon).toBe(false);
      expect((await again(run, "manual")).retrySoon).toBe(true);
    });

    it("an agent entry that cannot be saved: failed with a limited retry, never ready", async () => {
      const run = await prepare(ready);
      const update = run.sdk.plugins.updateSettings.bind(run.sdk.plugins);
      let refuse = true;
      run.sdk.plugins.updateSettings = (async (request: { pluginId: string }) => {
        if (refuse && request.pluginId === "provider-acp") throw new Error("bb refused");
        return update(request as never);
      }) as typeof run.sdk.plugins.updateSettings;
      const first = await again(run);
      expect(first.opencode?.install?.state).toBe("failed");
      expect(first.opencode?.install?.message).toContain("bb refused");
      expect(first.retrySoon).toBe(true);
      await again(run);
      expect((await again(run)).retrySoon).toBe(false);
      refuse = false;
      const fixed = await again(run);
      expect(fixed.opencode?.install?.state).toBe("ready");
      expect(fixed.managed.opencodeSetupFailures).toBe(null);
    });

    it("a state that cannot be published does not take the retry away", async () => {
      const run = await prepare(() => {
        throw new Error("disk gone");
      });
      run.deps.onOpenCode = async () => {
        throw new Error("store gone");
      };
      const outcome = await runSync(run.deps, "schedule");
      expect(outcome.retrySoon).toBe(true);
      expect(outcome.opencode?.install?.state).toBe("failed");
      expect(pluginCalls(run.calls).some((call) => call.includes("notes"))).toBe(true);
    });

    it.each(["broken", "denied"] as const)("%s counts towards the pause, and a sync the person starts begins the count again", async (reason) => {
      const run = await prepare((directory) => ({ state: "failed", reason, path: join(directory, "opencode"), detail: "x" }));
      const allowed: boolean[] = [];
      const inner = run.deps.ensureOpenCode!;
      run.deps.ensureOpenCode = async (files, directory, version, mayDownload) => {
        allowed.push(mayDownload);
        return inner(files, directory, version, mayDownload);
      };
      run.deps.now = () => 1_000_000;
      await again(run);
      await again(run);
      await again(run);
      await again(run);
      expect(allowed).toEqual([true, true, true, false]);
      expect((await again(run, "manual")).managed.opencodeFailures?.count).toBe(1);
      await again(run);
      expect(allowed[allowed.length - 1]).toBe(true);
    });

    it("the build's own texts reach the wrapper: deniedMessage with the path, failedMessage when it stops", async () => {
      const denied = await prepare((directory) => ({ state: "failed", reason: "denied", path: join(directory, "opencode"), detail: "x" }), { deniedMessage: "Заявка в ИТ: {path}" });
      await again(denied);
      expect(JSON.parse(await readFile(stateFile(denied), "utf8")).message).toBe(`Заявка в ИТ: ${join(denied.installDir, "opencode")}`);
      const entry = JSON.parse(String((await denied.sdk.plugins.getSettings({ pluginId: "provider-acp" })).values.customAgents)).find((one: { id: string }) => one.id === "opencode");
      expect(entry.env.ACP_SHIM_DENIED).toBe(`Заявка в ИТ: ${join(denied.installDir, "opencode")}`);
      const stopped = await prepare((directory) => ({ state: "failed", reason: "no-file", path: join(directory, "opencode"), detail: "x" }), { failedMessage: "Пульт пока не повторяет" });
      await again(stopped);
      expect(JSON.parse(await readFile(stateFile(stopped), "utf8")).message).toBe("Пульт пока не повторяет");
    });
  });

  it("writes the provider limit and the agent before OpenCode exists, and only then plugins", async () => {
    const run = await prepare((directory) => ({ state: "failed", reason: "download", path: join(directory, "opencode"), detail: "offline" }));
    const seen: Array<string | undefined> = [];
    run.deps.onOpenCode = async (status) => void seen.push(status.install?.state);
    let callsWhenManifestRead = -1;
    run.deps.onManifest = async () => void (callsWhenManifestRead = pluginCalls(run.calls).filter((call) => call.includes("notes")).length);
    const outcome = await runSync(run.deps, "start");
    expect(JSON.parse(run.config()).enabled_providers).toEqual(["corp"]);
    expect(run.order[0]).not.toContain("notes");
    const agent = JSON.parse(run.agent())[0];
    expect(agent).toMatchObject({ id: "opencode", command: "/app", env: { ELECTRON_RUN_AS_NODE: "1", ACP_SHIM_NOT_READY: "wait please" } });
    expect(agent.args).toEqual([join(run.installDir, "bb-acp-shim.cjs"), join(run.installDir, "opencode"), "acp"]);
    expect(seen).toEqual(["installing", "failed"]);
    expect(callsWhenManifestRead).toBe(0);
    expect(pluginCalls(run.calls).some((call) => call.includes("notes"))).toBe(true);
    expect(outcome.retrySoon).toBe(true);
    expect(outcome.report.steps.find((step) => step.code === "opencodeInstallFailed")).toMatchObject({ outcome: "error" });
    expect(outcome.opencode).toMatchObject({ installed: false, install: { state: "failed" } });
  });

  it("names the program and the IT request when the system refuses it, and does not rush to try again", async () => {
    const run = await prepare((directory) => ({ state: "failed", reason: "denied", path: join(directory, "opencode"), detail: "EPERM" }));
    const outcome = await runSync(run.deps, "start");
    const step = outcome.report.steps.find((one) => one.code === "opencodeDenied")!;
    expect(step.outcome).toBe("error");
    expect(step.message).toContain(join(run.installDir, "opencode"));
    expect(step.message).toContain("IT");
    expect(outcome.retrySoon).toBe(false);
    expect(outcome.opencode?.install?.state).toBe("denied");
  });

  it("turns other agents off before installing plugins", async () => {
    const run = await prepare((directory) => ({ state: "failed", reason: "download", path: join(directory, "opencode"), detail: "offline" }));
    const manifest = { ...withInstall(), agents: { allowed: ["acp-opencode"] } };
    await writeFile(run.path, JSON.stringify(manifest));
    await runSync(run.deps, "start");
    const firstOff = run.calls.findIndex((call) => call.startsWith("agent ") && call.includes("off"));
    const firstInstall = run.calls.findIndex((call) => call.includes("notes"));
    expect(firstOff).toBeGreaterThanOrEqual(0);
    expect(firstOff).toBeLessThan(firstInstall);
  });

  it("keeps the person's other agents and a copy of the value it replaces", async () => {
    const mine = JSON.stringify([{ id: "mine", command: "x" }]);
    const run = await prepare((directory) => ({ state: "failed", reason: "download", path: join(directory, "opencode"), detail: "offline" }));
    Object.assign((await run.sdk.plugins.getSettings({ pluginId: "provider-acp" })).values, {});
    await run.sdk.plugins.updateSettings({ pluginId: "provider-acp", values: { customAgents: mine } });
    await runSync(run.deps, "start");
    expect(JSON.parse(run.agent()).map((agent: { id: string }) => agent.id)).toEqual(["mine", "opencode"]);
    const backups = await readdir(join(run.installDir, "backup"));
    expect(await readFile(join(run.installDir, "backup", backups[0]!), "utf8")).toBe(mine);
  });

  it("without the install folder it only looks for an OpenCode and still writes the provider limit", async () => {
    const first = await setup(withInstall(), [self()]);
    const outcome = await runSync(first.deps, "start");
    expect(outcome.report.steps.find((step) => step.code === "opencodeMissing")).toMatchObject({ outcome: "warning" });
    expect(JSON.parse(await readFile(join(first.deps.environment.HOME!, ".config", "opencode", "opencode.json"), "utf8")).enabled_providers).toEqual(["corp"]);
    expect(outcome.opencode?.install ?? null).toBeNull();
  });
});

describe("branches", () => {
  const REPORTS_SOURCE = "git:https://git.example.test/plugins.git@semver:reports/:^1.0.0";
  const BOARD_SOURCE = "git:https://git.example.test/plugins.git@semver:board/:^1.0.0";
  /** notes: shared by every branch; reports: on in sales only; board: on in engineering only; fleet-kit: required. */
  function branched() {
    const manifest = sampleManifest();
    (manifest.plugins as unknown[]).push({ id: "reports", source: REPORTS_SOURCE, status: "required" }, { id: "board", source: BOARD_SOURCE, status: "required" });
    manifest.branches = {
      optional: [
        { id: "notes", title: "Notes" },
        { id: "reports", title: "Reports" },
        { id: "board", title: "Board" },
      ],
      list: [
        { id: "sales", title: "Sales", plugins: { board: false } },
        { id: "engineering", title: "Engineering", plugins: { reports: false } },
      ],
    };
    return manifest;
  }
  const plain = (id: string, source: string, overrides: Partial<FakePlugin> = {}): FakePlugin => ({ id, source, version: "1.0.0", enabled: true, schema: {}, values: {}, ...overrides });
  const reports = (overrides: Partial<FakePlugin> = {}) => plain("reports", REPORTS_SOURCE, overrides);
  const board = (overrides: Partial<FakePlugin> = {}) => plain("board", BOARD_SOURCE, overrides);
  const choice = (branch: string | null, plugins: Record<string, boolean> = {}) => ({ branch, plugins, at: "2026-11-07T10:00:00Z" });
  const stepOf = (outcome: { report: { steps: { item: string }[] } }, id: string) => outcome.report.steps.find((step) => step.item === id);

  it("on a machine that already has the build: installs everything as before and turns nothing off until a branch is picked", async () => {
    const managed = emptyManaged();
    managed.plugins.notes = { manifestSource: NOTES_SOURCE, bbSource: NOTES_SOURCE };
    const { deps, calls } = await setup(branched(), [self(), notes()], managed);
    const outcome = await runSync(deps, "start");
    expect(outcome.managed.branchStart).toBe("all");
    expect(callsOf(calls, "disable")).toEqual([]);
    expect(callsOf(calls, "install")).toEqual(["install reports", "install board"]);
    expect(outcome.report.steps.filter((step) => step.outcome === "error")).toEqual([]);
  });

  it("on a new machine: installs the shared set at once, and only what differs between branches waits", async () => {
    const { deps, calls } = await setup(branched(), [self()]);
    const outcome = await runSync(deps, "start");
    expect(outcome.managed.branchStart).toBe("wait");
    expect(callsOf(calls, "install")).toEqual(["install notes"]);
    expect(stepOf(outcome, "reports")).toMatchObject({ outcome: "skipped", code: "pluginAwaitsChoice" });
    expect(stepOf(outcome, "board")).toMatchObject({ outcome: "skipped", code: "pluginAwaitsChoice" });
    // The decision holds: plugins installed meanwhile do not turn this machine into an old one.
    deps.managed = outcome.managed;
    deps.choice = choice("engineering");
    const picked = await runSync(deps, "manual");
    expect(callsOf(calls, "install")).toEqual(["install notes", "install board"]);
    expect(stepOf(picked, "reports")).toMatchObject({ outcome: "skipped", code: "pluginNotChosen" });
  });

  it("tells the First run page where this machine stands before any plugin installs", async () => {
    const { deps, calls } = await setup(branched(), [self()]);
    const seen: string[] = [];
    deps.onManifest = async (_manifest, branches) => {
      seen.push(`${branches.start} after ${callsOf(calls, "install").length} installs`);
    };
    await runSync(deps, "start");
    expect(seen).toEqual(["wait after 0 installs"]);
  });

  it("a shared plugin can be turned off before a branch is picked", async () => {
    const { deps, calls } = await setup(branched(), [self(), notes()]);
    deps.managed = { ...emptyManaged(), branchStart: "wait" };
    deps.choice = choice(null, { notes: false });
    await runSync(deps, "manual");
    expect(callsOf(calls, "disable")).toEqual(["disable notes"]);
    expect(callsOf(calls, "install")).toEqual([]);
  });

  it("turns an installed plugin off without removing it or touching its settings, and back on", async () => {
    const { deps, calls, plugins } = await setup(branched(), [self(), notes(), reports({ values: { token: "kept" } }), board()]);
    deps.choice = choice("engineering");
    const off = await runSync(deps, "manual");
    expect(callsOf(calls, "disable")).toEqual(["disable reports"]);
    expect(callsOf(calls, "remove reports")).toEqual([]);
    expect(plugins.get("reports")).toMatchObject({ enabled: false, values: { token: "kept" } });
    expect(stepOf(off, "reports")).toMatchObject({ outcome: "changed", code: "pluginTurnedOff" });
    // The next sync leaves it off and quiet.
    calls.length = 0;
    deps.managed = off.managed;
    const again = await runSync(deps, "schedule");
    expect(callsOf(calls, "disable")).toEqual([]);
    expect(callsOf(calls, "enable")).toEqual([]);
    expect(stepOf(again, "reports")).toMatchObject({ outcome: "skipped", code: "pluginOffByChoice" });
    // The person turns it on again: the same plugin comes back, nothing is installed.
    calls.length = 0;
    deps.managed = again.managed;
    deps.choice = choice("engineering", { reports: true });
    await runSync(deps, "manual");
    expect(callsOf(calls, "enable")).toEqual(["enable reports"]);
    expect(callsOf(calls, "install")).toEqual([]);
    expect(plugins.get("reports")).toMatchObject({ enabled: true, values: { token: "kept" } });
  });

  it("a branch dropped or renamed in the manifest leaves the person's plugins as they were", async () => {
    const { deps, calls } = await setup(branched(), [self(), notes(), reports(), board()]);
    deps.choice = choice("engineering");
    const first = await runSync(deps, "manual");
    expect(callsOf(calls, "disable")).toEqual(["disable reports"]);
    expect(first.managed.branchApplied).toEqual({ notes: true, reports: false, board: true });
    // The build renames "engineering": reports must stay off, board on.
    const renamed = branched();
    (renamed.branches as { list: { id: string }[] }).list[1]!.id = "eng";
    const { deps: later, calls: laterCalls, plugins } = await setup(renamed, [self(), notes(), reports({ enabled: false }), board()], first.managed);
    later.choice = choice("engineering");
    const after = await runSync(later, "schedule");
    expect(callsOf(laterCalls, "enable")).toEqual([]);
    expect(callsOf(laterCalls, "disable")).toEqual([]);
    expect(plugins.get("reports")!.enabled).toBe(false);
    expect(after.managed.branchApplied).toEqual(first.managed.branchApplied);
  });

  it("a plugin added to the build gets its default; the person's other switches stay", async () => {
    const next = branched();
    (next.plugins as unknown[]).push({ id: "extra", source: "git:https://git.example.test/plugins.git@semver:extra/:^1.0.0", status: "required" });
    (next.branches as { optional: unknown[] }).optional.push({ id: "extra", title: "Extra" });
    const { deps, calls } = await setup(next, [self(), notes({ enabled: false }), reports(), board({ enabled: false })]);
    deps.choice = choice("sales", { notes: false });
    await runSync(deps, "schedule");
    expect(callsOf(calls, "install")).toEqual(["install extra"]);
    expect(callsOf(calls, "enable")).toEqual([]);
    expect(callsOf(calls, "disable")).toEqual([]);
  });

  it("updates only the plugins that are on: one turned off keeps its version", async () => {
    const { deps, calls, plugins } = await setup(branched(), [self(), notes(), reports({ enabled: false, update: "1.1.0" }), board({ update: "1.1.0" })]);
    deps.choice = choice("engineering");
    await runSync(deps, "schedule");
    expect(callsOf(calls, "update")).toEqual(["update board"]);
    expect(plugins.get("reports")).toMatchObject({ enabled: false, version: "1.0.0" });
  });

  it("a plugin dropped from the manifest stays as it is: neither removed nor turned off", async () => {
    const without = branched();
    without.plugins = (without.plugins as { id: string }[]).filter((entry) => entry.id !== "board");
    (without.branches as { optional: unknown[] }).optional = [{ id: "notes", title: "Notes" }, { id: "reports", title: "Reports" }];
    for (const branch of (without.branches as { list: { plugins?: Record<string, boolean> }[] }).list) delete branch.plugins?.board;
    const managed = emptyManaged();
    managed.plugins.board = { manifestSource: BOARD_SOURCE, bbSource: BOARD_SOURCE };
    const { deps, calls, plugins } = await setup(without, [self(), notes(), reports(), board()], managed);
    deps.choice = choice("sales");
    const outcome = await runSync(deps, "schedule");
    expect(calls.filter((call) => call.endsWith(" board"))).toEqual([]);
    expect(plugins.get("board")!.enabled).toBe(true);
    expect(stepOf(outcome, "board")).toMatchObject({ outcome: "skipped", code: "pluginKept" });
  });

  it("a build without branches ignores a stored choice", async () => {
    const { deps, calls } = await setup(sampleManifest(), [self()]);
    deps.choice = choice("engineering", { notes: false });
    const outcome = await runSync(deps, "start");
    expect(callsOf(calls, "install")).toEqual(["install notes"]);
    expect(outcome.managed.branchStart).toBeNull();
  });

  it("gives the branch to a plugin that declares buildBranch", async () => {
    const { deps, calls, plugins } = await setup(branched(), [self(), notes({ schema: { greeting: { type: "string" }, buildBranch: { type: "string" } }, values: { greeting: "hello" } }), reports(), board()]);
    deps.choice = choice("sales");
    await runSync(deps, "manual");
    expect(callsOf(calls, "config notes")).toEqual(["config notes buildBranch"]);
    expect(plugins.get("notes")!.values.buildBranch).toBe("sales");
  });
});
