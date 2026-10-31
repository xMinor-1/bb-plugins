// One reconciliation pass: read the manifest, then bring this bb to it.
//
// Order: Fleet Kit's own update (decided from its manifest entry alone, so a
// manifest this version cannot read can still deliver a version that can),
// then the full manifest check, marketplaces, bb settings, plugins (install,
// reinstall on a source change, enable, update, settings), removals listed in
// `removePlugins`, OpenCode. Every item is isolated: one failure is reported
// and the rest still applies. A manifest with errors applies nothing but
// Fleet Kit's own update.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Notice, OpenCodeStatus, Step, SyncReport } from "../contract.js";
import { say, type Said } from "./shared/texts.js";
import {
  AI_TASKS,
  checkManifest,
  compareVersions,
  readSelfEntry,
  SELF_ID,
  selfSourcePinned,
  sourceProblem,
  type AiChoice,
  type AiTask,
  type Manifest,
  type ManifestPlugin,
} from "./manifest.js";
import { fetchManifestText, parseManifestJson, parseManifestLocation } from "./fetch-manifest.js";
import type { SecretStore } from "./secret-store.js";
import { planOpenCode, readOwnedValue, writeOpenCodeConfig, openCodeMajor, type OpenCodePlan } from "./host/opencode-config.js";
import { syncResolverPlugin } from "./host/opencode-resolver.js";
import { resolveOpenCodeLocation } from "./host/opencode-location.js";
import { checkOpenCodeConfiguration } from "./host/check-models.js";
import { readSystemPolicy } from "./host/system-policy.js";
import { lockState } from "./host/lock-state.js";
import { findOpenCode } from "./host/find-opencode.js";

export { SELF_ID };

type Sdk = BbPluginApi["sdk"];

export interface FleetKitSettings {
  manifestUrl: string;
  manifestToken: string | undefined;
  syncIntervalMinutes: number;
  opencodeConfigDir: string;
  /** Set by hand on a test machine: path:, npm: and local git sources, loopback gateways. */
  allowDevSources: boolean;
  paused: boolean;
}

/** Fleet Kit's own update attempts: the same version at most twice a day. */
export interface SelfUpdateRecord {
  version: string;
  attempts: number;
  /** When the first attempt in the current window started. */
  at: string;
}

export interface InstallArgs {
  source: string;
  plugin?: string;
  subdirectory?: string;
}

/**
 * A plugin's switch to the source the manifest lists. bb cannot switch in
 * place, so a switch removes the plugin first; a failed one puts the previous
 * source back. At most SOURCE_CHANGE_LIMIT tries a day, SOURCE_RETRY_MS
 * apart; between tries the plugin stays on its previous source untouched.
 */
export interface SourceChangeRecord {
  target: string;
  /** Where the plugin came from, to put it back when the switch fails. */
  previous: InstallArgs;
  /** Plain (non-secret) settings to restore after a reinstall. */
  keep: Record<string, unknown>;
  /** It had secret settings, which a reinstall clears. */
  secrets: boolean;
  attempts: number;
  /** When the first try in the current window started. */
  at: string;
  /** When the last try started. */
  last: string;
  /** The plugin was removed and is installed from neither source yet. */
  pending: boolean;
}

/** A first install whose wait timed out: bb may still be running it. */
export interface PendingInstall {
  source: string;
  at: string;
}

export interface ManagedState {
  plugins: Record<string, { manifestSource: string; bbSource: string }>;
  opencode: { configFile: string; directory: string; owned: string[][] } | null;
  selfUpdate: SelfUpdateRecord | null;
  sourceChanges: Record<string, SourceChangeRecord>;
  installs: Record<string, PendingInstall>;
  /** bb agent providers Fleet Kit keeps turned off; one found on again was turned on by hand. */
  agents: { disabled: string[] };
}

export const emptyManaged = (): ManagedState => ({
  plugins: {},
  opencode: null,
  selfUpdate: null,
  sourceChanges: {},
  installs: {},
  agents: { disabled: [] },
});

export const SELF_UPDATE_LIMIT = 2;
export const SOURCE_CHANGE_LIMIT = 2;
export const SOURCE_RETRY_MS = 60 * 60_000;
/** A Fleet Kit update started this long ago still counts as running. */
export const SELF_UPDATE_RUNNING_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  /**
   * When this process last started Fleet Kit's own update. A sync that runs
   * while that update is still going neither counts a try nor starts another.
   */
  selfUpdateStartedAt?: number | undefined;
  /** For tests. */
  now?: () => number;
  /** For tests: how long to wait for one install. */
  installMs?: number;
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
  add(area: Step["area"], item: string, outcome: Step["outcome"], text: Said | string) {
    const said = typeof text === "string" ? say("raw", { text: text.slice(0, 600) }) : text;
    this.list.push({ area, item, outcome, code: said.code, params: said.params, message: said.message.slice(0, 600) });
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 400);

// A hung bb call must not keep the sync (and the panel's "Syncing…") forever.
const CALL_MS = 60_000;
const INSTALL_MS = 10 * 60_000;

/** The wait ended, not the call: bb may still finish it. */
class TimedOut extends Error {}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimedOut(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function overall(steps: Step[]): SyncReport["outcome"] {
  if (steps.some((step) => step.outcome === "error")) return "error";
  if (steps.some((step) => step.outcome === "warning")) return "warning";
  if (steps.some((step) => step.outcome === "changed")) return "changed";
  return "ok";
}

/** Older saved state: drop fields this version no longer keeps. */
function loadManaged(saved: ManagedState): ManagedState {
  const copy = JSON.parse(JSON.stringify(saved)) as Partial<ManagedState> & Record<string, unknown>;
  return {
    plugins: copy.plugins ?? {},
    opencode: copy.opencode ?? null,
    selfUpdate: copy.selfUpdate ?? null,
    sourceChanges: copy.sourceChanges ?? {},
    installs: copy.installs ?? {},
    agents: { disabled: copy.agents?.disabled ?? [] },
  };
}

export async function runSync(deps: SyncDeps, trigger: SyncReport["trigger"]): Promise<SyncOutcome> {
  const startedAt = new Date().toISOString();
  const steps = new Steps();
  const managed = loadManaged(deps.managed);
  const notices: Notice[] = [];
  let fleetKitOutdated = false;
  const finish = (manifest: Manifest | null, opencode: OpenCodeStatus | null, selfUpdate = false): SyncOutcome => ({
    report: {
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome: overall(steps.list),
      build: manifest ? { name: manifest.name, version: manifest.version } : null,
      fleetKitOutdated,
      steps: steps.list,
    },
    manifest,
    managed,
    opencode,
    notices,
    selfUpdate,
  });

  // ------------------------------------------------------------ manifest
  let raw: unknown;
  let display: string;
  try {
    const location = parseManifestLocation(deps.settings.manifestUrl);
    display = location.display;
    raw = parseManifestJson(await fetchManifestText(location, { token: deps.settings.manifestToken, signal: deps.signal }));
  } catch (error) {
    steps.add("manifest", "manifest", "error", say("manifestUnreadable", { error: errorText(error) }));
    return finish(null, null);
  }

  // --------------------------------------------------- Fleet Kit's update
  let selfUpdate = false;
  try {
    selfUpdate = await checkSelfUpdate(deps, raw, managed, steps);
  } catch (error) {
    steps.add("plugin", SELF_ID, "warning", say("selfUpdateCheckFailed", { error: errorText(error) }));
  }

  const check = checkManifest(raw, { allowDevSources: deps.settings.allowDevSources });
  for (const warning of check.warnings) steps.add("manifest", "manifest", "warning", warning);
  if (check.manifest === null) {
    for (const error of check.errors) steps.add("manifest", "manifest", "error", error);
    if (check.newerFormat) {
      fleetKitOutdated = true;
      steps.add(
        "manifest",
        "manifest",
        "error",
        selfUpdate
          ? say("needsNewerSoon")
          : say("needsNewerNone"),
      );
    } else {
      steps.add("manifest", "manifest", "error", say("manifestHasErrors"));
    }
    return finish(null, null, selfUpdate);
  }
  const manifest = check.manifest;
  steps.add("manifest", display, "ok", say("manifestRead", { name: manifest.name, version: manifest.version }));

  const version = (await within(deps.sdk.system.version(), CALL_MS, "Reading the bb version")).currentVersion;
  if (version !== "0.0.0" && compareVersions(version, manifest.bb.minVersion) < 0) {
    steps.add("bb", "version", "error", say("bbTooOld", { need: manifest.bb.minVersion, have: version }));
    return finish(manifest, null, selfUpdate);
  }

  // -------------------------------------------------------- marketplaces
  if ((manifest.marketplaces ?? []).length > 0) {
    try {
      const existing = await within(deps.sdk.plugins.marketplaces.list(), CALL_MS, "Listing marketplaces");
      for (const wanted of manifest.marketplaces ?? []) {
        const present = existing.some((market) => market.source === wanted.source && (market.subdirectory ?? undefined) === wanted.subdirectory);
        if (present) continue;
        try {
          await within(
            deps.sdk.plugins.marketplaces.add(wanted.subdirectory ? { source: wanted.source, subdirectory: wanted.subdirectory } : { source: wanted.source }),
            INSTALL_MS,
            "Adding the marketplace",
          );
          steps.add("marketplace", wanted.source, "changed", say("marketplaceAdded"));
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
  try {
    await syncPlugins(deps, manifest, managed, steps, notices);
  } catch (error) {
    steps.add("plugin", "plugins", "error", errorText(error));
  }

  // ------------------------------------------- AI services and agents
  // After plugins: a build plugin may register the AI service or the agent it names.
  try {
    await applyAiServices(deps, manifest, steps);
  } catch (error) {
    steps.add("ai", "ai-services", "error", errorText(error));
  }
  try {
    await applyAgents(deps, manifest, managed, steps, notices);
  } catch (error) {
    steps.add("agent", "agents", "error", errorText(error));
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
        steps.add("secret", secret.name, "warning", say("secretMissing", { title: secret.title }));
      }
    } catch (error) {
      steps.add("secret", secret.name, "error", say("secretStoreUnreadable", { store: deps.store.label, error: errorText(error) }));
    }
  }

  return finish(manifest, opencode, selfUpdate);
}

type Installed = Awaited<ReturnType<Sdk["plugins"]["list"]>>["plugins"][number];

function isBuiltin(installed: Installed): boolean {
  return (installed as { provenance?: string }).provenance === "builtin" || installed.source.startsWith("builtin:");
}

function sameSource(id: string, manifestSource: string, installed: Installed, managed: ManagedState): boolean {
  if (installed.source === manifestSource) return true;
  const record = managed.plugins[id];
  return record !== undefined && record.manifestSource === manifestSource && record.bbSource === installed.source;
}

/**
 * Decide Fleet Kit's own update from its manifest entry alone. Returns true
 * when the update should start after this sync is saved.
 */
async function checkSelfUpdate(deps: SyncDeps, raw: unknown, managed: ManagedState, steps: Steps): Promise<boolean> {
  const entry = readSelfEntry(raw);
  if (entry === null) return false; // the full check reports the missing entry
  const problem = sourceProblem(entry.source, deps.settings.allowDevSources);
  if (problem !== null) {
    steps.add("plugin", SELF_ID, "warning", say("selfNotUpdating", { problem }));
    return false;
  }
  if (!selfSourcePinned(entry.source)) {
    steps.add("plugin", SELF_ID, "warning", say("selfNotPinned"));
    return false;
  }
  const installed = (await within(deps.sdk.plugins.list(), CALL_MS, "Listing plugins")).plugins.find((plugin) => plugin.id === SELF_ID);
  if (installed === undefined) return false;
  if (!sameSource(SELF_ID, entry.source, installed, managed)) {
    steps.add("plugin", SELF_ID, "warning", say("selfOtherSource"));
    return false;
  }
  const [check] = await within(deps.sdk.plugins.checkUpdates({ pluginId: SELF_ID, signal: deps.signal }), 2 * CALL_MS, "Checking for a Fleet Kit update");
  if (check?.outcome !== "update-available") return false;
  const now = (deps.now ?? Date.now)();
  // A sync while the update runs (a rerun, a manual sync) sees the same offer:
  // it must neither count another try nor start a second update.
  if (deps.selfUpdateStartedAt !== undefined && now - deps.selfUpdateStartedAt < SELF_UPDATE_RUNNING_MS) {
    steps.add("plugin", SELF_ID, "skipped", say("selfUpdateRunning"));
    return false;
  }
  const jobs = await within(Promise.resolve(deps.sdk.plugins.experimental_updateJobs?.list({ signal: deps.signal }) ?? null), CALL_MS, "Listing update jobs").catch(() => null);
  if (jobs === null) {
    steps.add("plugin", SELF_ID, "warning", say("selfUpdateJobsUnknown"));
    return false;
  }
  if (jobs.some((job) => job.pluginId === SELF_ID && (job.state === "queued" || job.state === "running"))) {
    steps.add("plugin", SELF_ID, "skipped", say("selfUpdateRunning"));
    return false;
  }
  // `version` identifies the candidate (a commit for git sources); `label` reads well.
  const target = check.candidate?.version ?? check.candidate?.label ?? "latest";
  const shown = check.candidate?.label ?? target;
  const record = managed.selfUpdate;
  const sameWindow = record !== null && record.version === target && now - Date.parse(record.at) < DAY_MS;
  const attempts = sameWindow ? record.attempts : 0;
  if (attempts >= SELF_UPDATE_LIMIT) {
    const retry = new Date(Date.parse(record!.at) + DAY_MS).toISOString();
    steps.add("plugin", SELF_ID, "warning", say("selfUpdateGaveUp", { version: shown, attempts, retry }));
    return false;
  }
  managed.selfUpdate = { version: target, attempts: attempts + 1, at: sameWindow ? record!.at : new Date(now).toISOString() };
  steps.add("plugin", SELF_ID, "changed", say("selfUpdateAvailable", { version: shown }));
  return true;
}

async function applyBbSettings(deps: SyncDeps, manifest: Manifest, steps: Steps) {
  const wanted = manifest.bb.settings ?? {};
  if (Object.keys(wanted).length === 0) return;
  try {
    const config = await within(deps.sdk.system.config(), CALL_MS, "Reading bb settings");
    const current = config.generalSettings as unknown as Record<string, unknown>;
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(wanted)) {
      if (!(key in current)) {
        steps.add("bb", key, "error", say("bbSettingUnknown", { key }));
        continue;
      }
      const present = current[key];
      if (present !== null && typeof present !== typeof value) {
        steps.add("bb", key, "error", say("bbSettingType", { key, type: typeof present }));
        continue;
      }
      if (present !== value) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) return;
    await within(
      deps.sdk.system.updateGeneralSettings({ ...current, ...changes } as Parameters<Sdk["system"]["updateGeneralSettings"]>[0]),
      CALL_MS,
      "Saving bb settings",
    );
    for (const [key, value] of Object.entries(changes)) steps.add("bb", key, "changed", say("bbSettingSet", { value: JSON.stringify(value) }));
  } catch (error) {
    steps.add("bb", "settings", "error", errorText(error));
  }
}

async function syncPlugins(deps: SyncDeps, manifest: Manifest, managed: ManagedState, steps: Steps, notices: Notice[]): Promise<void> {
  const { sdk } = deps;
  const byId = new Map<string, Installed>((await within(sdk.plugins.list(), CALL_MS, "Listing plugins")).plugins.map((plugin) => [plugin.id, plugin]));

  for (const entry of manifest.plugins) {
    deps.signal.throwIfAborted();
    if (entry.id === SELF_ID) continue; // handled first, from the raw manifest
    if (entry.status === "planned") {
      steps.add("plugin", entry.id, "skipped", say("pluginPlanned"));
      continue;
    }
    try {
      await syncOnePlugin(deps, manifest, managed, entry, byId, steps, notices);
    } catch (error) {
      steps.add("plugin", entry.id, "error", errorText(error));
    }
  }

  // Removal is explicit only: a plugin missing from the manifest stays, so a
  // short or broken manifest cannot strip every machine of its plugins.
  const removals = new Set(manifest.removePlugins ?? []);

  // A switch or first install left unfinished for a plugin the build no longer
  // installs (dropped from plugins, or now planned) is finished here, so the
  // plugin is not left removed.
  const active = new Set(manifest.plugins.filter((entry) => entry.status !== "planned").map((entry) => entry.id));
  for (const id of Object.keys(managed.installs)) if (!active.has(id)) delete managed.installs[id];
  for (const [id, record] of Object.entries(managed.sourceChanges)) {
    if (active.has(id)) continue;
    try {
      await settleAbandoned(deps, managed, id, record, removals.has(id), byId, steps, notices);
    } catch (error) {
      steps.add("plugin", id, "error", errorText(error));
    }
  }

  const listed = new Set(manifest.plugins.map((entry) => entry.id));
  for (const id of Object.keys(managed.plugins)) {
    if (listed.has(id)) continue;
    delete managed.plugins[id];
    if (byId.has(id) && !removals.has(id)) {
      steps.add("plugin", id, "skipped", say("pluginKept"));
    }
  }
  for (const id of removals) {
    const installed = byId.get(id);
    if (installed === undefined || id === SELF_ID) continue;
    if (isBuiltin(installed)) {
      steps.add("plugin", id, "warning", say("pluginBundled"));
      continue;
    }
    try {
      await within(sdk.plugins.remove({ pluginId: id }), CALL_MS, "Removing the plugin");
      steps.add("plugin", id, "changed", say("pluginRemoved"));
    } catch (error) {
      steps.add("plugin", id, "error", say("pluginRemoveFailed", { error: errorText(error) }));
    }
  }
}

/** Install from `args` and make sure bb installed the plugin the manifest names. */
async function installChecked(deps: SyncDeps, id: string, args: InstallArgs, byId: Map<string, Installed>) {
  const { sdk } = deps;
  const result = await within(sdk.plugins.install(args), deps.installMs ?? INSTALL_MS, "Installing the plugin");
  if (result.id !== id) {
    if (!byId.has(result.id)) await within(sdk.plugins.remove({ pluginId: result.id }), CALL_MS, "Removing the wrong plugin").catch(() => undefined);
    throw new Error(`the source installs the plugin "${result.id}", not "${id}"`);
  }
  return result;
}

/** Whether bb is still installing one of `sources`; null when that cannot be told. */
async function installRunning(deps: SyncDeps, sources: string[]): Promise<boolean | null> {
  try {
    const jobs = await within(deps.sdk.plugins.installJobs.list({ signal: deps.signal }), CALL_MS, "Listing install jobs");
    return jobs.some((job) =>
      (job.state === "queued" || job.state === "running" || job.state === "cancelling") &&
      job.target.kind === "source" && sources.includes(job.target.source));
  } catch {
    return null;
  }
}

/** The plugin as bb lists it now: null when absent, undefined when the list cannot be read. */
async function listedNow(deps: SyncDeps, id: string): Promise<Installed | null | undefined> {
  try {
    return (await within(deps.sdk.plugins.list(), CALL_MS, "Listing plugins")).plugins.find((plugin) => plugin.id === id) ?? null;
  } catch {
    return undefined;
  }
}

/** Whether `installed` came from `source`: bb may list a source in its own spelling. */
async function installedFrom(deps: SyncDeps, installed: Installed, source: string): Promise<boolean> {
  if (installed.source === source) return true;
  const detail = await within(deps.sdk.plugins.getSource({ pluginId: installed.id, signal: deps.signal }), CALL_MS, "Reading its source").catch(() => null);
  return detail?.requested === source;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** When the next switch to `target` may start; null when it may start now. */
function nextSourceTry(record: SourceChangeRecord | undefined, target: string, now: number): string | null {
  if (record === undefined || record.target !== target) return null;
  const windowStart = Date.parse(record.at);
  if (!(now - windowStart < DAY_MS)) return null;
  if (record.attempts >= SOURCE_CHANGE_LIMIT) return iso(windowStart + DAY_MS);
  const gap = Date.parse(record.last) + SOURCE_RETRY_MS;
  return now < gap ? iso(gap) : null;
}

/** Count one more try to switch to `target`. */
function countSourceTry(record: SourceChangeRecord, target: string, now: number) {
  const sameWindow = record.target === target && now - Date.parse(record.at) < DAY_MS;
  record.target = target;
  record.attempts = sameWindow ? record.attempts + 1 : 1;
  if (!sameWindow) record.at = iso(now);
  record.last = iso(now);
}

/** The ways to put a previous source back, the most specific first. */
function previousForms(previous: InstallArgs, id: string): InstallArgs[] {
  const forms: InstallArgs[] = [];
  if (previous.subdirectory) forms.push({ source: previous.source, subdirectory: previous.subdirectory });
  forms.push({ source: previous.source, plugin: id }, { source: previous.source });
  return forms;
}

interface PluginContext {
  deps: SyncDeps;
  managed: ManagedState;
  entry: ManifestPlugin;
  byId: Map<string, Installed>;
  steps: Steps;
  notices: Notice[];
  now: number;
}

function reinstallNotice(ctx: PluginContext, text: Said) {
  ctx.notices.push({ id: `reinstalled:${ctx.entry.id}:${randomUUID().slice(0, 8)}`, kind: "reinstalled", at: new Date().toISOString(), ...text });
}

async function restoreSettings(ctx: PluginContext, keep: Record<string, unknown>) {
  if (Object.keys(keep).length === 0) return;
  await within(ctx.deps.sdk.plugins.updateSettings({ pluginId: ctx.entry.id, values: keep as Record<string, never> }), CALL_MS, "Restoring its settings").catch((error) => {
    ctx.steps.add("plugin", ctx.entry.id, "warning", say("settingsRestoreFailed", { error: errorText(error) }));
  });
}

/** The switch landed: the plugin is on the manifest's source. */
async function switched(ctx: PluginContext, record: SourceChangeRecord, installed: Installed): Promise<Installed> {
  const { entry, managed } = ctx;
  managed.plugins[entry.id] = { manifestSource: entry.source!, bbSource: installed.source };
  delete managed.sourceChanges[entry.id];
  ctx.steps.add("plugin", entry.id, "changed", say("reinstalled", { version: installed.version }));
  await restoreSettings(ctx, record.keep);
  if (record.secrets) reinstallNotice(ctx, say("noticeReinstalled", { plugin: entry.id }));
  return installed;
}

/** The plugin is installed again, though not from the manifest's source: settings and secrets as after any reinstall. */
async function settled(ctx: PluginContext, record: SourceChangeRecord, notice: Said) {
  record.pending = false;
  await restoreSettings(ctx, record.keep);
  if (record.secrets) reinstallNotice(ctx, notice);
}

/**
 * Put the previous source back: "back" when it is installed, "running" when
 * bb is still at it after the wait (no other form is tried then), "failed"
 * when no form of it installs.
 */
async function putPreviousBack(ctx: PluginContext, record: SourceChangeRecord): Promise<"back" | "running" | "failed"> {
  const { deps, entry } = ctx;
  for (const args of previousForms(record.previous, entry.id)) {
    try {
      await installChecked(deps, entry.id, args, ctx.byId);
    } catch (error) {
      if (error instanceof TimedOut) return "running";
      continue; // try the next form
    }
    await settled(ctx, record, say("noticePutBack", { plugin: entry.id }));
    return "back";
  }
  return "failed";
}

/**
 * Install the manifest's source after the plugin was removed. A failed
 * install is checked against what bb lists now before anything else is
 * installed: a timed-out install may still finish, and a second source under
 * the same id must not race it.
 */
async function trySwitch(ctx: PluginContext, record: SourceChangeRecord): Promise<Installed | null> {
  const { deps, entry, steps } = ctx;
  try {
    return await switched(ctx, record, await installChecked(deps, entry.id, installArgs(entry), ctx.byId));
  } catch (error) {
    const now = await listedNow(deps, entry.id);
    if (now === undefined) {
      steps.add("plugin", entry.id, "warning", say("switchListUnknown", { error: errorText(error) }));
      return null;
    }
    if (now !== null) {
      if (await installedFrom(deps, now, entry.source!)) return switched(ctx, record, now);
      await settled(ctx, record, say("noticeReinstalledDuringSwitch", { plugin: entry.id }));
      steps.add("plugin", entry.id, "warning", say("switchOtherSource", { error: errorText(error), source: now.source }));
      return null;
    }
    if (error instanceof TimedOut && (await installRunning(deps, [entry.source!])) !== false) {
      steps.add("plugin", entry.id, "warning", say("switchStillInstalling"));
      return null;
    }
    const next = nextSourceTry(record, entry.source!, ctx.now) ?? "";
    const back = await putPreviousBack(ctx, record);
    if (back === "back") {
      steps.add("plugin", entry.id, "error", say("switchRolledBack", { error: errorText(error), next }));
      return null;
    }
    if (back === "running") {
      steps.add("plugin", entry.id, "error", say("switchRollbackRunning", { error: errorText(error) }));
      return null;
    }
    throw new Error(`Could not install it from the manifest's source, and the previous source could not be put back: ${errorText(error)}`);
  }
}

/** Start a switch of an installed plugin to the manifest's source. */
async function startSwitch(ctx: PluginContext, current: Installed, record: SourceChangeRecord | undefined): Promise<Installed | null> {
  const { deps, entry } = ctx;
  const { sdk } = deps;
  const before = await within(sdk.plugins.getSettings({ pluginId: entry.id, signal: deps.signal }), CALL_MS, "Reading its settings").catch(() => null);
  const detail = await within(sdk.plugins.getSource({ pluginId: entry.id, signal: deps.signal }), CALL_MS, "Reading its source").catch(() => null);
  const keep: Record<string, unknown> = {};
  let secrets = false;
  for (const [key, descriptor] of Object.entries(before?.schema ?? {})) {
    const value = before?.values?.[key];
    if ((descriptor as { secret?: boolean }).secret) {
      if (isSet(value)) secrets = true;
      continue;
    }
    if (value !== undefined && value !== null) keep[key] = value;
  }
  const previous: InstallArgs = { source: current.source };
  if (detail?.subdirectory) previous.subdirectory = detail.subdirectory;
  const next: SourceChangeRecord = record ?? { target: entry.source!, previous, keep, secrets, attempts: 0, at: iso(ctx.now), last: iso(ctx.now), pending: false };
  Object.assign(next, { previous, keep, secrets });
  countSourceTry(next, entry.source!, ctx.now);
  ctx.managed.sourceChanges[entry.id] = next;

  await within(sdk.plugins.remove({ pluginId: entry.id }), CALL_MS, "Removing the plugin");
  next.pending = true;
  return trySwitch(ctx, next);
}

/**
 * Finish a source switch for a plugin the build no longer installs. A
 * finished switch only drops its record; one that left the plugin removed
 * gets the previous source back once no install of it runs, unless the build
 * lists the plugin in removePlugins.
 */
async function settleAbandoned(
  deps: SyncDeps,
  managed: ManagedState,
  id: string,
  record: SourceChangeRecord,
  removing: boolean,
  byId: Map<string, Installed>,
  steps: Steps,
  notices: Notice[],
) {
  if (!record.pending || removing) {
    delete managed.sourceChanges[id];
    return;
  }
  const entry = { id, source: record.target, status: "required" } as ManifestPlugin;
  const ctx: PluginContext = { deps, managed, entry, byId, steps, notices, now: (deps.now ?? Date.now)() };
  const now = await listedNow(deps, id);
  if (now === undefined) {
    steps.add("plugin", id, "warning", say("abandonedListUnknown"));
    return;
  }
  if (now !== null) {
    await settled(ctx, record, say("noticeReinstalledDuringSwitch", { plugin: id }));
    delete managed.sourceChanges[id];
    steps.add("plugin", id, "skipped", say("abandonedKept", { source: now.source }));
    return;
  }
  const running = await installRunning(deps, [record.target, record.previous.source]);
  if (running !== false) {
    steps.add("plugin", id, "warning", running ? say("abandonedInstalling") : say("abandonedJobsUnknown"));
    return;
  }
  const back = await putPreviousBack(ctx, record);
  if (back === "failed") throw new Error("No longer in the build, and its previous source, removed for a source switch, could not be put back.");
  if (back === "running") {
    steps.add("plugin", id, "warning", say("abandonedRollbackRunning"));
    return;
  }
  delete managed.sourceChanges[id];
  steps.add("plugin", id, "changed", say("abandonedPutBack"));
}

type AiServices = Awaited<ReturnType<Sdk["system"]["aiServices"]>>;
type AiSelection = AiServices["selections"][AiTask];

/** The selection a manifest choice means here, and how to report it. */
function resolveAiChoice(services: AiServices, task: AiTask, choice: AiChoice): { selection: AiSelection; text: Said; warning: boolean } {
  if (choice === "off") return { selection: { mode: "off" }, text: say("aiOff"), warning: false };
  if (choice === "automatic") return { selection: { mode: "automatic" }, text: say("aiAutomatic"), warning: false };
  const service = typeof choice === "string" ? choice : choice.service;
  const plugin = typeof choice === "string" ? undefined : choice.plugin;
  const found = services.services.filter((entry) => entry.id === service && entry.tasks.includes(task) && (plugin === undefined || entry.pluginId === plugin));
  // Never fall back to "automatic": that may pick bb cloud. Off until the named service is there.
  if (found.length === 0) return { selection: { mode: "off" }, text: say("aiServiceMissing", { service }), warning: true };
  if (found.length > 1) {
    return { selection: { mode: "off" }, text: say("aiServiceAmbiguous", { service, plugins: found.map((entry) => entry.pluginId).join(", ") }), warning: true };
  }
  const [one] = found as [AiServices["services"][number]];
  return { selection: { mode: "service", pluginId: one.pluginId, serviceId: one.id }, text: say("aiService", { service: one.displayName }), warning: false };
}

function sameAiSelection(a: AiSelection, b: AiSelection): boolean {
  if (a.mode !== b.mode) return false;
  return a.mode !== "service" || (b.mode === "service" && a.pluginId === b.pluginId && a.serviceId === b.serviceId);
}

/** Hold bb's AI service choices (`bb settings ai-services`) at the manifest's. */
async function applyAiServices(deps: SyncDeps, manifest: Manifest, steps: Steps) {
  const wanted = manifest.aiServices;
  if (wanted === undefined) return;
  let services: AiServices;
  try {
    services = await within(deps.sdk.system.aiServices({ signal: deps.signal }), CALL_MS, "Reading bb's AI services");
  } catch (error) {
    steps.add("ai", "ai-services", "error", errorText(error));
    return;
  }
  for (const task of AI_TASKS) {
    const choice = wanted[task];
    if (choice === undefined) continue;
    const { selection, text, warning } = resolveAiChoice(services, task, choice);
    if (sameAiSelection(services.selections[task], selection)) {
      steps.add("ai", task, warning ? "warning" : "ok", text);
      continue;
    }
    try {
      services = await within(deps.sdk.system.setAiServiceSelection({ task, selection }), CALL_MS, "Saving the AI service choice");
      steps.add("ai", task, warning ? "warning" : "changed", text);
    } catch (error) {
      steps.add("ai", task, "error", errorText(error));
    }
  }
}

type AgentEntry = Awaited<ReturnType<Sdk["providers"]["catalog"]>>[number];

/** bb can run the agent: its program is there and its plugin is on. */
function agentReady(entry: AgentEntry): boolean {
  return entry.available && entry.pluginEnabled;
}

/**
 * Keep only the manifest's agents enabled. An allowlist, so a provider a
 * later bb adds is turned off as well. Nothing is turned off until one of the
 * allowed agents is on and ready: the person must never be left without a
 * working agent. An allowed agent that is not ready is not turned on either
 * (bb refuses it), so a sync never repeats a call bb already refused.
 */
async function applyAgents(deps: SyncDeps, manifest: Manifest, managed: ManagedState, steps: Steps, notices: Notice[]) {
  const policy = manifest.agents;
  if (policy === undefined) return;
  let catalog = await within(deps.sdk.providers.catalog(), CALL_MS, "Listing bb's agents");
  const allowed = new Set(policy.allowed);
  const present = catalog.filter((entry) => allowed.has(entry.id));
  if (present.length === 0) {
    steps.add("agent", "agents", "error", say("agentsNoneHere", { allowed: policy.allowed.join(", ") }));
    return;
  }
  for (const id of policy.allowed) if (!catalog.some((entry) => entry.id === id)) steps.add("agent", id, "warning", say("agentAllowedMissing"));
  const shown = present.map((entry) => entry.displayName).join(", ");

  for (const entry of present) {
    if (!agentReady(entry)) {
      steps.add("agent", entry.displayName, "warning", say(entry.pluginEnabled ? "agentUnavailable" : "agentPluginOff"));
      continue;
    }
    if (entry.enabled) continue;
    try {
      catalog = await within(deps.sdk.providers.setEnabled({ providerId: entry.id, enabled: true }), CALL_MS, "Turning the agent on");
      steps.add("agent", entry.displayName, "changed", say("agentEnabled"));
    } catch (error) {
      steps.add("agent", entry.displayName, "error", errorText(error));
    }
  }
  const working = catalog.filter((entry) => allowed.has(entry.id) && entry.enabled && agentReady(entry));
  if (working.length === 0) {
    steps.add("agent", "agents", "error", say("agentsNoneReady", { allowed: shown }));
    return; // keep managed.agents: a later sync still knows which agents it turned off
  }

  const disabledBefore = new Set(managed.agents.disabled);
  const disabled: string[] = [];
  for (const entry of catalog) {
    if (allowed.has(entry.id)) continue;
    if (!entry.enabled) {
      disabled.push(entry.id);
      continue;
    }
    try {
      await within(deps.sdk.providers.setEnabled({ providerId: entry.id, enabled: false }), CALL_MS, "Turning the agent off");
    } catch (error) {
      steps.add("agent", entry.displayName, "error", errorText(error));
      if (disabledBefore.has(entry.id)) disabled.push(entry.id);
      continue;
    }
    disabled.push(entry.id);
    if (disabledBefore.has(entry.id)) {
      // Turned on by hand since Fleet Kit turned it off: say so once in the panel.
      steps.add("agent", entry.displayName, "warning", say("agentDisabledAgain", { allowed: shown }));
      notices.push({ id: `agent-disabled:${entry.id}`, kind: "agent-disabled", at: new Date().toISOString(), ...say("noticeAgentDisabled", { agent: entry.displayName, allowed: shown }) });
    } else {
      steps.add("agent", entry.displayName, "changed", say("agentDisabled", { allowed: shown }));
    }
  }
  managed.agents = { disabled };
}

function installArgs(entry: ManifestPlugin): InstallArgs {
  const args: InstallArgs = { source: entry.source! };
  if (entry.plugin) args.plugin = entry.plugin;
  if (entry.subdirectory) args.subdirectory = entry.subdirectory;
  return args;
}

async function syncOnePlugin(
  deps: SyncDeps,
  manifest: Manifest,
  managed: ManagedState,
  entry: ManifestPlugin,
  byId: Map<string, Installed>,
  steps: Steps,
  notices: Notice[],
) {
  const { sdk } = deps;
  const ctx: PluginContext = { deps, managed, entry, byId, steps, notices, now: (deps.now ?? Date.now)() };
  let current: Installed | null | undefined = byId.get(entry.id);
  if (current !== undefined && isBuiltin(current)) {
    steps.add("plugin", entry.id, "error", say("pluginIdBundled"));
    return;
  }
  const record = managed.sourceChanges[entry.id];

  if (current !== undefined && sameSource(entry.id, entry.source!, current, managed)) {
    if (record !== undefined) {
      // A switch that timed out earlier finished after all.
      if (record.pending) current = await switched(ctx, record, current);
      else delete managed.sourceChanges[entry.id];
    }
  } else if (current !== undefined) {
    // Same id from another source: bb cannot switch sources in place.
    if (record?.pending && (await installedFrom(deps, current, entry.source!))) {
      current = await switched(ctx, record, current);
    } else {
      // An install that timed out earlier put some source in place after all.
      if (record?.pending) await settled(ctx, record, say("noticeReinstalledDuringSwitch", { plugin: entry.id }));
      const wait = nextSourceTry(record, entry.source!, ctx.now);
      if (wait !== null) {
        // Between tries the plugin stays on its previous source, untouched.
        steps.add("plugin", entry.id, "warning", say("switchWaiting", { attempts: record!.attempts, next: wait }));
        return;
      }
      current = await startSwitch(ctx, current, record);
      if (current === null) return;
    }
  } else if (record?.pending) {
    // Removed for a switch that has not landed: never start a second install over a running one.
    const running = await installRunning(deps, [entry.source!, record.target, record.previous.source]);
    if (running !== false) {
      steps.add("plugin", entry.id, "warning", running ? say("stillInstalling") : say("jobsUnknown"));
      return;
    }
    const wait = nextSourceTry(record, entry.source!, ctx.now);
    if (wait !== null) {
      const back = await putPreviousBack(ctx, record);
      if (back === "failed") throw new Error("Its previous source could not be put back.");
      steps.add(
        "plugin",
        entry.id,
        "warning",
        back === "back"
          ? say("putBackWaiting", { attempts: record.attempts, next: wait })
          : say("rollbackRunning"),
      );
      return;
    }
    countSourceTry(record, entry.source!, ctx.now);
    current = await trySwitch(ctx, record);
    if (current === null) return;
  } else {
    if (record !== undefined) delete managed.sourceChanges[entry.id];
    // After an install that timed out, never start one over it: an unknown job list waits too.
    const pending = managed.installs[entry.id];
    const sources = pending !== undefined && pending.source !== entry.source ? [entry.source!, pending.source] : [entry.source!];
    const running = await installRunning(deps, sources);
    if (running === true || (running === null && pending !== undefined)) {
      steps.add(
        "plugin",
        entry.id,
        "warning",
        running ? say("stillInstalling") : say("jobsUnknown"),
      );
      return;
    }
    try {
      current = await installChecked(deps, entry.id, installArgs(entry), byId);
    } catch (error) {
      if (error instanceof TimedOut) {
        managed.installs[entry.id] = { source: entry.source!, at: iso(ctx.now) };
        steps.add("plugin", entry.id, "warning", say("installTimedOut", { seconds: Math.round((deps.installMs ?? INSTALL_MS) / 1000) }));
        return;
      }
      delete managed.installs[entry.id];
      throw error;
    }
    delete managed.installs[entry.id];
    managed.plugins[entry.id] = { manifestSource: entry.source!, bbSource: current.source };
    steps.add("plugin", entry.id, "changed", say("installed", { version: current.version }));
  }

  if (current === undefined || current === null) return;
  // Installed, whichever way: a first install that timed out has a result.
  delete managed.installs[entry.id];
  if (managed.plugins[entry.id] === undefined) managed.plugins[entry.id] = { manifestSource: entry.source!, bbSource: current.source };
  if (!current.enabled) {
    current = await within(sdk.plugins.enable({ pluginId: entry.id }), CALL_MS, "Enabling the plugin");
    steps.add("plugin", entry.id, "changed", say("enabled"));
  }
  // Pinned sources answer "pinned"; tracking ones may have an update.
  const [check] = await within(sdk.plugins.checkUpdates({ pluginId: entry.id, signal: deps.signal }), 2 * CALL_MS, "Checking for an update");
  if (check?.outcome === "update-available") {
    const update = await within(sdk.plugins.applyUpdate({ pluginId: entry.id }), INSTALL_MS, "Updating the plugin");
    if (update.outcome === "updated") steps.add("plugin", entry.id, "changed", say("updated", { version: update.to?.label ?? "" }));
    else steps.add("plugin", entry.id, "warning", update.outcome === "rolled-back" ? say("updateRolledBack") : say("updateNotApplied"));
  }

  await applyPluginConfig(deps, manifest, entry, steps);
  if (!steps.list.some((step) => step.area === "plugin" && step.item === entry.id)) {
    steps.add("plugin", entry.id, "ok", say("upToDate", { version: current.version }));
  }
}

function isSet(value: unknown): boolean {
  if (value && typeof value === "object" && "set" in value) return (value as { set: unknown }).set === true;
  return value !== undefined && value !== null && value !== "";
}

async function applyPluginConfig(deps: SyncDeps, manifest: Manifest, entry: ManifestPlugin, steps: Steps) {
  const { sdk } = deps;
  const settings = await within(sdk.plugins.getSettings({ pluginId: entry.id, signal: deps.signal }), CALL_MS, "Reading its settings");
  const schema = (settings.schema ?? {}) as Record<string, { secret?: boolean; type?: string }>;
  const desired: Record<string, string | number | boolean> = {};
  // Build-wide values every plugin can opt into by declaring the setting.
  if ("allowedProviders" in schema) desired.allowedProviders = manifest.allowedProviders.join(",");
  if ("opencodeConfigDir" in schema) desired.opencodeConfigDir = deps.settings.opencodeConfigDir;
  for (const [key, value] of Object.entries(entry.config ?? {})) desired[key] = value;

  const changes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(desired)) {
    const descriptor = schema[key];
    const fromManifest = key in (entry.config ?? {});
    if (descriptor === undefined) {
      if (fromManifest) steps.add("plugin", entry.id, "warning", say("noSuchSetting", { key }));
      continue;
    }
    // Secret settings are the person's to enter; a manifest never carries them.
    if (descriptor.secret) {
      if (fromManifest) steps.add("plugin", entry.id, "warning", say("secretSettingSkipped", { key }));
      continue;
    }
    if (settings.values?.[key] !== value) changes[key] = value;
  }
  if (Object.keys(changes).length === 0) return;
  await within(sdk.plugins.updateSettings({ pluginId: entry.id, values: changes }), CALL_MS, "Saving its settings");
  steps.add("plugin", entry.id, "changed", say("settingsApplied", { keys: Object.keys(changes).join(", ") }));
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
    steps.add("opencode", "OpenCode", "warning", say("opencodeMissing"));
    return status;
  }
  status.installed = true;
  status.version = binary.version;
  let major: number;
  try {
    major = openCodeMajor(binary.version);
  } catch {
    steps.add("opencode", "OpenCode", "warning", say("opencodeUnsupported", { version: String(binary.version) }));
    return status;
  }
  if (major !== 2) {
    steps.add("opencode", "OpenCode", "warning", say("opencodeTooOld", { version: String(binary.version) }));
    return status;
  }

  const location = resolveOpenCodeLocation({ opencodeConfigDir: deps.settings.opencodeConfigDir, environment: deps.environment });
  status.configFile = location.configFile;
  let plan: OpenCodePlan;
  try {
    plan = planOpenCode(manifest.opencode as Record<string, unknown>, manifest.allowedProviders, { allowDevSources: deps.settings.allowDevSources });
  } catch (error) {
    steps.add("opencode", "opencode.json", "error", errorText(error));
    return status;
  }

  // The config file moved (the directory setting changed): clean the old one first.
  if (managed.opencode && managed.opencode.configFile !== location.configFile) {
    try {
      await writeOpenCodeConfig(managed.opencode.configFile, { entries: [], resolver: {}, secrets: [] }, managed.opencode.owned, { signal: deps.signal, timeoutMs: 30_000 });
      await syncResolverPlugin(managed.opencode.directory, null);
      steps.add("opencode", managed.opencode.configFile, "changed", say("previousConfigCleaned"));
    } catch (error) {
      steps.add("opencode", managed.opencode.configFile, "warning", say("previousConfigCleanFailed", { error: errorText(error) }));
    }
    managed.opencode = null;
  }

  const previouslyOwned = managed.opencode?.owned ?? [];
  try {
    const result = await writeOpenCodeConfig(location.configFile, plan, previouslyOwned, { signal: deps.signal });
    managed.opencode = { configFile: location.configFile, directory: location.directory, owned: plan.entries.map((entry) => entry.path) };
    if (result.changed) {
      steps.add("opencode", location.configFile, "changed", say("configUpdated", { backup: result.backup ?? "" }));
    }
  } catch (error) {
    const lock = await lockState(location.configFile).catch(() => null);
    if (lock) status.lock = lock;
    steps.add("opencode", location.configFile, "error", errorText(error));
    return status;
  }

  try {
    const changed = await syncResolverPlugin(location.directory, { providers: plan.resolver, store: deps.store });
    if (changed) steps.add("opencode", "secret resolver", "changed", say("resolverUpdated", { store: deps.store.label }));
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
      say("modelPickerDirectory", { directory: location.directory }),
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
