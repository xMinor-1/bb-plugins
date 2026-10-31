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
  schema: Record<string, { type: string; secret?: boolean }>;
  values: Record<string, unknown>;
  update?: string;
}

function fakeSdk(initial: FakePlugin[], general: Record<string, unknown> = { telemetryEnabled: true, streamerMode: false }) {
  const plugins = new Map(initial.map((plugin) => [plugin.id, clone(plugin)]));
  const calls: string[] = [];
  const view = (plugin: FakePlugin) => ({ id: plugin.id, source: plugin.source, version: plugin.version, enabled: plugin.enabled });
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
    hosts: { providerCliStatus: async () => ({}) },
    plugins: {
      marketplaces: { list: async () => [], add: async () => ({}) },
      list: async () => ({ plugins: [...plugins.values()].map(view) }),
      install: async ({ source }: { source: string; plugin?: string }) => {
        const id = source.includes("notes") ? "notes" : "other";
        calls.push(`install ${id}`);
        const plugin: FakePlugin = { id, source, version: "1.0.0", enabled: true, schema: schemaFor(id), values: {} };
        plugins.set(id, plugin);
        return view(plugin);
      },
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
        return [{ id: pluginId, outcome: plugin?.update ? "update-available" : "current" }];
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
  return { sdk, plugins, calls, general };
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
    settings: { manifestUrl: path, manifestToken: undefined, syncIntervalMinutes: 30, opencodeConfigDir: "", paused: false },
    store,
    managed,
    signal: new AbortController().signal,
    environment: { HOME: dir },
  };
  return { ...fake, deps, store, path };
}

const self: FakePlugin = { id: "fleet-kit", source: "git:https://git.example.test/plugins.git", version: "0.1.0", enabled: true, schema: {}, values: {} };

describe("sync", () => {
  it("installs, configures, removes, and holds bb settings on a fresh bb", async () => {
    const old: FakePlugin = { id: "old-thing", source: "npm:old-thing", version: "1.0.0", enabled: true, schema: {}, values: {} };
    const { deps, calls, general } = await setup(sampleManifest(), [self, old]);
    const outcome = await runSync(deps, "start");
    expect(calls).toContain("install notes");
    expect(calls).toContain("config notes allowedProviders,greeting");
    expect(calls).toContain("remove old-thing");
    expect(general.telemetryEnabled).toBe(false);
    expect(general.streamerMode).toBe(false);
    expect(outcome.managed.plugins.notes).toEqual({
      manifestSource: "git:https://git.example.test/plugins.git@semver:notes/:^1.0.0",
      bbSource: "git:https://git.example.test/plugins.git@semver:notes/:^1.0.0",
    });
    const kinds = outcome.report.steps.map((step) => `${step.area}:${step.item}:${step.outcome}`);
    expect(kinds).toContain("plugin:later:skipped");
    expect(kinds).toContain("secret:gateway-key:warning");
    expect(kinds).toContain("opencode:OpenCode:warning");
    expect(outcome.report.build).toEqual({ name: "Example build", version: "1.2.0" });
  });

  it("is quiet on a second pass and applies an update the source offers", async () => {
    const first = await setup(sampleManifest(), [self]);
    const outcome = await runSync(first.deps, "start");
    first.calls.length = 0;
    first.plugins.get("notes")!.update = "1.1.0";
    const second = await runSync({ ...first.deps, managed: outcome.managed }, "schedule");
    expect(first.calls).toEqual(["update notes"]);
    expect(second.report.steps.find((step) => step.item === "notes")?.message).toBe("Updated to 1.1.0.");
  });

  it("reinstalls on a source change, keeps plain settings, and asks for secrets again", async () => {
    const existing: FakePlugin = {
      id: "notes",
      source: "git:https://git.example.test/plugins.git@semver:notes/:^0.9.0",
      version: "0.9.3",
      enabled: false,
      schema: { greeting: { type: "string" }, token: { type: "string", secret: true }, allowedProviders: { type: "string" } },
      values: { greeting: "custom", token: "t" },
    };
    const { deps, calls, plugins } = await setup(sampleManifest(), [self, existing]);
    const outcome = await runSync(deps, "manual");
    // Restore the old plain settings first, then apply the manifest's values.
    expect(calls.filter((call) => !call.startsWith("settings"))).toEqual([
      "remove notes",
      "install notes",
      "config notes greeting",
      "config notes allowedProviders,greeting",
    ]);
    expect(plugins.get("notes")!.values.greeting).toBe("hello");
    expect(outcome.notices.map((notice) => notice.kind)).toEqual(["reinstalled"]);
  });

  it("enables a disabled plugin and resolves secret settings from the store", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[1].config = { token: "{secret:gateway-key}" };
    const existing: FakePlugin = {
      id: "notes",
      source: manifest.plugins[1].source,
      version: "1.0.0",
      enabled: false,
      schema: { token: { type: "string", secret: true } },
      values: {},
    };
    const { deps, calls, store, plugins } = await setup(manifest, [self, existing]);
    let outcome = await runSync(deps, "manual");
    expect(calls).toContain("enable notes");
    expect(outcome.report.steps.some((step) => step.message.includes("waits for the secret gateway-key"))).toBe(true);
    await store.set("gateway-key", "s3");
    calls.length = 0;
    outcome = await runSync({ ...deps, managed: outcome.managed }, "manual");
    expect(calls).toEqual(["config notes token"]);
    expect(plugins.get("notes")!.values.token).toBe("s3");
    calls.length = 0;
    await runSync({ ...deps, managed: outcome.managed }, "manual");
    expect(calls).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain("s3");
  });

  it("removes plugins it installed when the build drops them", async () => {
    const first = await setup(sampleManifest(), [self]);
    const outcome = await runSync(first.deps, "start");
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins = manifest.plugins.filter((plugin: any) => plugin.id !== "notes");
    await writeFile(first.path, JSON.stringify(manifest));
    first.calls.length = 0;
    const second = await runSync({ ...first.deps, managed: outcome.managed }, "schedule");
    expect(first.calls).toEqual(["remove notes"]);
    expect(second.managed.plugins.notes).toBeUndefined();
  });

  it("applies nothing from a manifest with errors", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.allowedProviders = ["other"];
    const { deps, calls } = await setup(manifest, [self]);
    const outcome = await runSync(deps, "manual");
    expect(calls).toEqual([]);
    expect(outcome.report.outcome).toBe("error");
    expect(outcome.manifest).toBeNull();
  });

  it("reports an unknown bb setting instead of sending it", async () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.bb.settings = { noSuchSetting: true };
    const { deps, calls } = await setup(manifest, [self]);
    const outcome = await runSync(deps, "manual");
    expect(calls.some((call) => call.startsWith("settings"))).toBe(false);
    expect(outcome.report.steps.find((step) => step.item === "noSuchSetting")?.outcome).toBe("error");
  });
});
