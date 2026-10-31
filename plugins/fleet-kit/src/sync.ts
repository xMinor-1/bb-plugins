// One reconciliation pass: read the manifest, then bring this bb to it.
//
// Order: marketplaces, bb settings, plugins (install, reinstall on a source
// change, enable, update, settings), removals, OpenCode, and Fleet Kit's own
// update last (it restarts the plugin). Every item is isolated: one failure
// is reported and the rest still applies. A manifest with errors applies
// nothing.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Notice, OpenCodeStatus, Step, SyncReport } from "../contract.js";
import { checkManifest, compareVersions, type Manifest, type ManifestPlugin } from "./manifest.js";
import { fetchManifestText, parseManifestJson, parseManifestLocation } from "./fetch-manifest.js";
import type { SecretStore } from "./secret-store.js";
import { planOpenCode, readOwnedValue, writeOpenCodeConfig, openCodeMajor, type OpenCodePlan } from "./host/opencode-config.js";
import { syncResolverPlugin } from "./host/opencode-resolver.js";
import { resolveOpenCodeLocation } from "./host/opencode-location.js";
import { checkOpenCodeConfiguration } from "./host/check-models.js";
import { readSystemPolicy } from "./host/system-policy.js";
import { lockState } from "./host/lock-state.js";
import { findOpenCode } from "./host/find-opencode.js";

export const SELF_ID = "fleet-kit";

type Sdk = BbPluginApi["sdk"];

export interface FleetKitSettings {
  manifestUrl: string;
  manifestToken: string | undefined;
  syncIntervalMinutes: number;
  opencodeConfigDir: string;
  paused: boolean;
}

export interface ManagedState {
  plugins: Record<string, { manifestSource: string; bbSource: string }>;
  /** sha256 of secret values Fleet Kit last wrote into other plugins' secret settings. */
  secretConfig: Record<string, string>;
  opencode: { configFile: string; directory: string; owned: string[][] } | null;
}

export const emptyManaged = (): ManagedState => ({ plugins: {}, secretConfig: {}, opencode: null });

export interface SyncDeps {
  sdk: Sdk;
  log: BbPluginApi["log"];
  settings: FleetKitSettings;
  store: SecretStore;
  managed: ManagedState;
  signal: AbortSignal;
  /** Process environment that bb gives OpenCode (plus Fleet Kit's contribution). */
  environment: NodeJS.ProcessEnv;
  /**
   * OPENCODE_CONFIG_DIR of bb's own process. bb lists OpenCode models without
   * plugin-contributed variables, so the model picker reads only this one.
   */
  bbConfigDir?: string | undefined;
}

export interface SyncOutcome {
  report: SyncReport;
  manifest: Manifest | null;
  managed: ManagedState;
  opencode: OpenCodeStatus | null;
  notices: Notice[];
  /** Start Fleet Kit's own update after the outcome is saved. */
  selfUpdate: boolean;
}

class Steps {
  readonly list: Step[] = [];
  add(area: Step["area"], item: string, outcome: Step["outcome"], message: string) {
    this.list.push({ area, item, outcome, message: message.slice(0, 600) });
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 400);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function overall(steps: Step[]): SyncReport["outcome"] {
  if (steps.some((step) => step.outcome === "error")) return "error";
  if (steps.some((step) => step.outcome === "warning")) return "warning";
  if (steps.some((step) => step.outcome === "changed")) return "changed";
  return "ok";
}

export async function runSync(deps: SyncDeps, trigger: SyncReport["trigger"]): Promise<SyncOutcome> {
  const startedAt = new Date().toISOString();
  const steps = new Steps();
  const managed: ManagedState = JSON.parse(JSON.stringify(deps.managed));
  const notices: Notice[] = [];
  const finish = (manifest: Manifest | null, opencode: OpenCodeStatus | null, selfUpdate = false): SyncOutcome => ({
    report: {
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome: overall(steps.list),
      build: manifest ? { name: manifest.name, version: manifest.version } : null,
      steps: steps.list,
    },
    manifest,
    managed,
    opencode,
    notices,
    selfUpdate,
  });

  // ------------------------------------------------------------ manifest
  let manifest: Manifest;
  try {
    const location = parseManifestLocation(deps.settings.manifestUrl);
    const text = await fetchManifestText(location, { token: deps.settings.manifestToken, signal: deps.signal });
    const check = checkManifest(parseManifestJson(text));
    for (const warning of check.warnings) steps.add("manifest", "manifest", "warning", warning);
    if (check.manifest === null) {
      for (const error of check.errors) steps.add("manifest", "manifest", "error", error);
      steps.add("manifest", "manifest", "error", "The manifest has errors, so nothing was applied.");
      return finish(null, null);
    }
    manifest = check.manifest;
    steps.add("manifest", location.display, "ok", `Read ${manifest.name} ${manifest.version}.`);
  } catch (error) {
    steps.add("manifest", "manifest", "error", `Could not read the manifest: ${errorText(error)}`);
    return finish(null, null);
  }

  const version = (await deps.sdk.system.version()).currentVersion;
  if (version !== "0.0.0" && compareVersions(version, manifest.bb.minVersion) < 0) {
    steps.add("bb", "version", "error", `This build needs bb ${manifest.bb.minVersion} or newer; this bb is ${version}. Update bb.`);
    return finish(manifest, null);
  }

  // -------------------------------------------------------- marketplaces
  if ((manifest.marketplaces ?? []).length > 0) {
    try {
      const existing = await deps.sdk.plugins.marketplaces.list();
      for (const wanted of manifest.marketplaces ?? []) {
        const present = existing.some((market) => market.source === wanted.source && (market.subdirectory ?? undefined) === wanted.subdirectory);
        if (present) continue;
        try {
          await deps.sdk.plugins.marketplaces.add(wanted.subdirectory ? { source: wanted.source, subdirectory: wanted.subdirectory } : { source: wanted.source });
          steps.add("marketplace", wanted.source, "changed", "Added the marketplace.");
        } catch (error) {
          steps.add("marketplace", wanted.source, "error", errorText(error));
        }
      }
    } catch (error) {
      steps.add("marketplace", "marketplaces", "error", errorText(error));
    }
  }

  // --------------------------------------------------------- bb settings
  await applyBbSettings(deps, manifest, steps);

  // ------------------------------------------------------------- plugins
  let selfUpdate = false;
  try {
    selfUpdate = await syncPlugins(deps, manifest, managed, steps, notices);
  } catch (error) {
    steps.add("plugin", "plugins", "error", errorText(error));
  }

  // ------------------------------------------------------------ OpenCode
  let opencode: OpenCodeStatus | null = null;
  try {
    opencode = await syncOpenCode(deps, manifest, managed, steps);
  } catch (error) {
    steps.add("opencode", "OpenCode", "error", errorText(error));
  }

  // -------------------------------------------------------------- secrets
  for (const secret of manifest.secrets) {
    try {
      if (!(await deps.store.has(secret.name))) {
        steps.add("secret", secret.name, "warning", `${secret.title} is not set. Enter it in the Fleet Kit panel.`);
      }
    } catch (error) {
      steps.add("secret", secret.name, "error", `Could not read ${deps.store.label}: ${errorText(error)}`);
    }
  }

  return finish(manifest, opencode, selfUpdate);
}

async function applyBbSettings(deps: SyncDeps, manifest: Manifest, steps: Steps) {
  const wanted = manifest.bb.settings ?? {};
  if (Object.keys(wanted).length === 0) return;
  try {
    const config = await deps.sdk.system.config();
    const current = config.generalSettings as unknown as Record<string, unknown>;
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(wanted)) {
      if (!(key in current)) {
        steps.add("bb", key, "error", `bb has no general setting "${key}".`);
        continue;
      }
      const present = current[key];
      if (present !== null && typeof present !== typeof value) {
        steps.add("bb", key, "error", `bb expects a ${typeof present} for "${key}".`);
        continue;
      }
      if (present !== value) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) return;
    await deps.sdk.system.updateGeneralSettings({ ...current, ...changes } as Parameters<Sdk["system"]["updateGeneralSettings"]>[0]);
    for (const [key, value] of Object.entries(changes)) steps.add("bb", key, "changed", `Set to ${JSON.stringify(value)}.`);
  } catch (error) {
    steps.add("bb", "settings", "error", errorText(error));
  }
}

type Installed = Awaited<ReturnType<Sdk["plugins"]["list"]>>["plugins"][number];

function installArgs(entry: ManifestPlugin) {
  const args: { source: string; plugin?: string; subdirectory?: string } = { source: entry.source! };
  if (entry.plugin) args.plugin = entry.plugin;
  if (entry.subdirectory) args.subdirectory = entry.subdirectory;
  return args;
}

function sameSource(entry: ManifestPlugin, installed: Installed, managed: ManagedState): boolean {
  if (installed.source === entry.source) return true;
  const record = managed.plugins[entry.id];
  return record !== undefined && record.manifestSource === entry.source && record.bbSource === installed.source;
}

/** Returns true when Fleet Kit itself has an update to start after saving. */
async function syncPlugins(deps: SyncDeps, manifest: Manifest, managed: ManagedState, steps: Steps, notices: Notice[]): Promise<boolean> {
  const { sdk } = deps;
  const byId = new Map<string, Installed>((await sdk.plugins.list()).plugins.map((plugin) => [plugin.id, plugin]));
  let selfUpdate = false;

  for (const entry of manifest.plugins) {
    deps.signal.throwIfAborted();
    if (entry.status === "planned") {
      steps.add("plugin", entry.id, "skipped", "Planned; not installed yet.");
      continue;
    }
    const installed = byId.get(entry.id);
    if (entry.id === SELF_ID) {
      if (installed === undefined) continue;
      if (!sameSource(entry, installed, managed)) {
        steps.add("plugin", entry.id, "warning", "Fleet Kit is installed from a different source than the manifest lists. Reinstall it with the installer.");
      } else {
        try {
          const [check] = await sdk.plugins.checkUpdates({ pluginId: SELF_ID, signal: deps.signal });
          if (check?.outcome === "update-available") {
            selfUpdate = true;
            steps.add("plugin", entry.id, "changed", "A Fleet Kit update is available; it installs after this sync.");
          }
        } catch (error) {
          steps.add("plugin", entry.id, "warning", `Could not check for a Fleet Kit update: ${errorText(error)}`);
        }
      }
      continue;
    }
    try {
      await syncOnePlugin(deps, manifest, managed, entry, installed, steps, notices);
    } catch (error) {
      steps.add("plugin", entry.id, "error", errorText(error));
    }
  }

  const wanted = new Set(manifest.plugins.map((entry) => entry.id));
  const toRemove = new Set<string>(manifest.removePlugins ?? []);
  for (const id of Object.keys(managed.plugins)) if (!wanted.has(id)) toRemove.add(id);
  for (const id of toRemove) {
    if (id === SELF_ID) continue;
    if (!byId.has(id)) {
      delete managed.plugins[id];
      continue;
    }
    try {
      await sdk.plugins.remove({ pluginId: id });
      delete managed.plugins[id];
      steps.add("plugin", id, "changed", "Removed: the build no longer includes it.");
    } catch (error) {
      steps.add("plugin", id, "error", `Could not remove: ${errorText(error)}`);
    }
  }
  return selfUpdate;
}

async function syncOnePlugin(
  deps: SyncDeps,
  manifest: Manifest,
  managed: ManagedState,
  entry: ManifestPlugin,
  installed: Installed | undefined,
  steps: Steps,
  notices: Notice[],
) {
  const { sdk } = deps;
  let current = installed;
  let restore: Record<string, unknown> | null = null;

  if (current !== undefined && !sameSource(entry, current, managed)) {
    if (current.source.startsWith("builtin:")) {
      steps.add("plugin", entry.id, "error", "This id belongs to a plugin bundled with bb; pick another id.");
      return;
    }
    // Same id from another source: bb cannot switch sources in place.
    const before = await sdk.plugins.getSettings({ pluginId: entry.id }).catch(() => null);
    const hadSecrets =
      before !== null &&
      Object.entries(before.schema ?? {}).some(([key, descriptor]) => (descriptor as { secret?: boolean }).secret && isSet(before.values?.[key]));
    restore = {};
    for (const [key, descriptor] of Object.entries(before?.schema ?? {})) {
      if ((descriptor as { secret?: boolean }).secret) continue;
      const value = before?.values?.[key];
      if (value !== undefined && value !== null) restore[key] = value;
    }
    await sdk.plugins.remove({ pluginId: entry.id });
    for (const key of Object.keys(managed.secretConfig)) if (key.startsWith(`${entry.id}.`)) delete managed.secretConfig[key];
    current = undefined;
    steps.add("plugin", entry.id, "changed", "Removed to reinstall from the manifest's source.");
    if (hadSecrets) {
      notices.push({
        id: `reinstalled:${entry.id}:${randomUUID().slice(0, 8)}`,
        kind: "reinstalled",
        message: `${entry.id} was reinstalled from a new source. Enter its secret settings again.`,
        at: new Date().toISOString(),
      });
    }
  }

  if (current === undefined) {
    const result = await sdk.plugins.install(installArgs(entry));
    managed.plugins[entry.id] = { manifestSource: entry.source!, bbSource: result.source };
    steps.add("plugin", entry.id, "changed", `Installed ${result.version}.`);
    current = result;
    if (restore && Object.keys(restore).length > 0) {
      await sdk.plugins.updateSettings({ pluginId: entry.id, values: restore as Record<string, never> }).catch((error) => {
        steps.add("plugin", entry.id, "warning", `Could not restore its previous settings: ${errorText(error)}`);
      });
    }
  } else {
    if (managed.plugins[entry.id] === undefined) managed.plugins[entry.id] = { manifestSource: entry.source!, bbSource: current.source };
    if (!current.enabled) {
      current = await sdk.plugins.enable({ pluginId: entry.id });
      steps.add("plugin", entry.id, "changed", "Enabled.");
    }
    // Pinned sources answer "pinned"; tracking ones may have an update.
    const [check] = await sdk.plugins.checkUpdates({ pluginId: entry.id, signal: deps.signal });
    if (check?.outcome === "update-available") {
      const update = await sdk.plugins.applyUpdate({ pluginId: entry.id });
      if (update.outcome === "updated") steps.add("plugin", entry.id, "changed", `Updated to ${update.to?.label ?? "the latest compatible version"}.`);
      else steps.add("plugin", entry.id, "warning", `The update ${update.outcome === "rolled-back" ? "failed and was rolled back" : "did not apply"}.`);
    }
  }

  await applyPluginConfig(deps, manifest, managed, entry, steps);
  if (!steps.list.some((step) => step.area === "plugin" && step.item === entry.id)) {
    steps.add("plugin", entry.id, "ok", `Up to date (${current.version}).`);
  }
}

function isSet(value: unknown): boolean {
  if (value && typeof value === "object" && "set" in value) return (value as { set: unknown }).set === true;
  return value !== undefined && value !== null && value !== "";
}

const SECRET_REF = /\{secret:([a-z0-9][a-z0-9-]*)\}/g;

async function applyPluginConfig(deps: SyncDeps, manifest: Manifest, managed: ManagedState, entry: ManifestPlugin, steps: Steps) {
  const { sdk } = deps;
  const settings = await sdk.plugins.getSettings({ pluginId: entry.id });
  const schema = (settings.schema ?? {}) as Record<string, { secret?: boolean; type?: string }>;
  const desired: Record<string, string | number | boolean> = {};
  // Build-wide values every plugin can opt into by declaring the setting.
  if ("allowedProviders" in schema) desired.allowedProviders = manifest.allowedProviders.join(",");
  if ("opencodeConfigDir" in schema) desired.opencodeConfigDir = deps.settings.opencodeConfigDir;
  for (const [key, value] of Object.entries(entry.config ?? {})) desired[key] = value;

  const changes: Record<string, string | number | boolean> = {};
  const secretHashes: Record<string, string> = {};
  for (const [key, raw] of Object.entries(desired)) {
    const descriptor = schema[key];
    if (descriptor === undefined) {
      if (key in (entry.config ?? {})) steps.add("plugin", entry.id, "warning", `It has no setting "${key}".`);
      continue;
    }
    let value: string | number | boolean = raw;
    if (typeof raw === "string" && /\{secret:/.test(raw)) {
      let resolved = raw;
      let missing: string | null = null;
      for (const match of raw.matchAll(SECRET_REF)) {
        const secret = await deps.store.get(match[1]!);
        if (secret === null) {
          missing = match[1]!;
          break;
        }
        resolved = resolved.split(match[0]).join(secret);
      }
      if (missing !== null) {
        steps.add("plugin", entry.id, "warning", `Setting "${key}" waits for the secret ${missing}.`);
        continue;
      }
      value = resolved;
    }
    if (descriptor.secret) {
      const marker = sha(`${entry.id}.${key}:${String(value)}`);
      const tracked = managed.secretConfig[`${entry.id}.${key}`];
      if (tracked === marker && isSet(settings.values?.[key])) continue;
      changes[key] = value;
      secretHashes[`${entry.id}.${key}`] = marker;
      continue;
    }
    if (settings.values?.[key] !== value) changes[key] = value;
  }
  if (Object.keys(changes).length === 0) return;
  await sdk.plugins.updateSettings({ pluginId: entry.id, values: changes });
  Object.assign(managed.secretConfig, secretHashes);
  const names = Object.keys(changes).map((key) => (schema[key]?.secret ? `${key} (secret)` : key));
  steps.add("plugin", entry.id, "changed", `Settings applied: ${names.join(", ")}.`);
}

async function syncOpenCode(deps: SyncDeps, manifest: Manifest, managed: ManagedState, steps: Steps): Promise<OpenCodeStatus> {
  const status: OpenCodeStatus = {
    installed: false,
    version: null,
    configFile: null,
    protection: "unknown",
    models: { state: "unchecked", message: "Not checked." },
    allowedProviders: [...manifest.allowedProviders],
    defaultModel: null,
    lock: null,
  };
  const binary = await findOpenCode(deps.environment);
  if (binary === null) {
    steps.add("opencode", "OpenCode", "warning", "OpenCode is not installed, so its models are not configured.");
    return status;
  }
  status.installed = true;
  status.version = binary.version;
  let major: number;
  try {
    major = openCodeMajor(binary.version);
  } catch {
    steps.add("opencode", "OpenCode", "warning", `OpenCode ${binary.version} is not supported. Update OpenCode to 2.x.`);
    return status;
  }
  if (major !== 2) {
    steps.add("opencode", "OpenCode", "warning", `OpenCode ${binary.version} is too old for this build. Update OpenCode to 2.x.`);
    return status;
  }

  const location = resolveOpenCodeLocation({ opencodeConfigDir: deps.settings.opencodeConfigDir, environment: deps.environment });
  status.configFile = location.configFile;
  let plan: OpenCodePlan;
  try {
    plan = planOpenCode(manifest.opencode as Record<string, unknown>, manifest.allowedProviders);
  } catch (error) {
    steps.add("opencode", "opencode.json", "error", errorText(error));
    return status;
  }

  // The config file moved (the directory setting changed): clean the old one first.
  if (managed.opencode && managed.opencode.configFile !== location.configFile) {
    try {
      await writeOpenCodeConfig(managed.opencode.configFile, { entries: [], resolver: {}, secrets: [] }, managed.opencode.owned, { signal: deps.signal, timeoutMs: 30_000 });
      await syncResolverPlugin(managed.opencode.directory, null);
      steps.add("opencode", managed.opencode.configFile, "changed", "Removed Fleet Kit's settings from the previous OpenCode configuration.");
    } catch (error) {
      steps.add("opencode", managed.opencode.configFile, "warning", `Could not clean the previous configuration: ${errorText(error)}`);
    }
    managed.opencode = null;
  }

  const previouslyOwned = managed.opencode?.owned ?? [];
  try {
    const result = await writeOpenCodeConfig(location.configFile, plan, previouslyOwned, { signal: deps.signal });
    managed.opencode = { configFile: location.configFile, directory: location.directory, owned: plan.entries.map((entry) => entry.path) };
    if (result.changed) {
      steps.add("opencode", location.configFile, "changed", result.backup ? `Updated; the original is saved as ${result.backup}.` : "Updated.");
    }
  } catch (error) {
    const lock = await lockState(location.configFile).catch(() => null);
    if (lock) status.lock = lock;
    steps.add("opencode", location.configFile, "error", errorText(error));
    return status;
  }

  try {
    const changed = await syncResolverPlugin(location.directory, { providers: plan.resolver, store: deps.store });
    if (changed) steps.add("opencode", "secret resolver", "changed", `Updated the OpenCode plugin that reads keys from ${deps.store.label}.`);
  } catch (error) {
    steps.add("opencode", "secret resolver", "error", errorText(error));
  }

  // Threads get the directory through Fleet Kit's env contribution, but bb
  // builds its model list without it (bb 0.48): that list shows the build's
  // models only when bb itself runs with the same OPENCODE_CONFIG_DIR.
  if (deps.settings.opencodeConfigDir !== "" && !sameDirectory(deps.bbConfigDir, location.directory)) {
    steps.add(
      "opencode",
      "model list",
      "warning",
      `bb's model picker reads the default OpenCode configuration, not ${location.directory}. Start bb with OPENCODE_CONFIG_DIR=${location.directory} so the picker shows the build's models; threads already use the directory.`,
    );
  }

  status.defaultModel = (await readCurrentModel(location.configFile)) ?? null;

  const system = await readSystemPolicy(manifest.allowedProviders);
  const probe = await mkdtemp(join(tmpdir(), "fleet-kit-models-"));
  try {
    const decision = await checkOpenCodeConfiguration({
      allowedProviders: manifest.allowedProviders.join(","),
      projectDirectory: probe,
      environment: deps.environment,
      opencodeConfigDir: deps.settings.opencodeConfigDir,
      command: binary.command,
      timeoutMs: 60_000,
      signal: deps.signal,
    });
    if (decision.state === "verified") {
      status.models = { state: "verified", message: `Only ${manifest.allowedProviders.join(", ")} models are available.` };
      status.protection = system.state === "verified" ? "system-policy" : "user-setting";
    } else if (decision.state === "unrestricted") {
      status.models = { state: "unrestricted", message: decision.warning };
      status.protection = "none";
    } else {
      status.models = { state: "blocked", message: decision.reason };
      status.protection = "none";
      steps.add("opencode", "models", "warning", decision.reason);
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  return status;
}

function sameDirectory(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const clean = (value: string) => normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);
}

async function readCurrentModel(configFile: string): Promise<string | undefined> {
  try {
    const value = readOwnedValue(await readFile(configFile, "utf8"), ["model"]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
