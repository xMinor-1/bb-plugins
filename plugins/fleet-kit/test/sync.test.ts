import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyManaged, runSync, type ManagedState, type SyncDeps } from "../src/sync.js";
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
  return "other";
}

function fakeSdk(initial: FakePlugin[], general: Record<string, unknown> = { telemetryEnabled: true, streamerMode: false }) {
  const plugins = new Map(initial.map((plugin) => [plugin.id, clone(plugin)]));
  const calls: string[] = [];
  const installs: Array<{ source: string; plugin?: string; subdirectory?: string }> = [];
  /** Installs of a "slow" source wait here until a test finishes them. */
  const slow: Array<{ source: string; finish: () => void }> = [];
  const updateJobs: Array<{ id: string; pluginId: string; state: string }> = [];
  const view = (plugin: FakePlugin) => ({ id: plugin.id, source: plugin.source, version: plugin.version, enabled: plugin.enabled, provenance: plugin.provenance ?? "direct" });
  const schemaFor = (id: string): FakePlugin["schema"] =>
    id === "notes" ? { greeting: { type: "string" }, token: { type: "string", secret: true }, allowedProviders: { type: "string" } } : {};
  const sdk = {
    system: {
      version: async () => ({ currentVersion: "0.48.1" }),
      config: async () => ({ generalSettings: { ...general }, primaryHostId: "host_1" }),
      updateGeneralSettings: async (next: Record<string, unknown>) => {
        calls.push(`settings ${JSON.stringify(next)}`);
        Object.assign(general, next);
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
        list: async () => slow.map((job, index) => ({ id: `job_${index}`, displayName: job.source, state: "running", target: { kind: "source", source: job.source, selection: { kind: "root" } } })),
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
  return { sdk, plugins, calls, general, installs, slow, updateJobs };
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
    environment: { HOME: dir },
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
const pluginCalls = (calls: string[]) => calls.filter((call) => !call.startsWith("settings") && call !== "check fleet-kit");

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
    expect(message(four)).toContain("after 2026-11-01T10:00:00.000Z");

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
