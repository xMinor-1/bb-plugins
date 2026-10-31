// Fleet Kit backend: keeps this bb in line with a build manifest.
//
// A background service reads the manifest on start and every
// `syncIntervalMinutes`, then installs, updates and removes plugins, holds
// bb settings, and merges the build's OpenCode block into opencode.json.
// The panel (app.tsx) and `bb fleet-kit` show the result and run a sync on
// demand. Secrets are stored in the operating system's credential store.
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, STATUS_CHANNEL, type Notice, type OpenCodeStatus, type Status, type SyncReport } from "./contract.js";
import { checkSecretValue, openSecretStore, SECRET_NAME, type SecretStore, type SecretStorePreference } from "./src/secret-store.js";
import { emptyManaged, runSync, SELF_ID, type FleetKitSettings, type ManagedState } from "./src/sync.js";
import { parseManifestLocation } from "./src/fetch-manifest.js";
import { opencodeConfigDirSchema } from "./src/shared/settings.js";
import { resolveOpenCodeLocation } from "./src/host/opencode-location.js";
import { lockState, resetStuckLock } from "./src/host/lock-state.js";

export { rpcContract };

const START_DELAY_MS = 15_000;

interface StoredSecrets {
  list: { name: string; title: string; hint: string | null }[];
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    manifestUrl: {
      type: "string",
      label: "Manifest address (https:// URL, file:// URL or absolute path)",
      default: "",
      experimental_schema: z.string().max(2000),
    },
    manifestToken: {
      type: "string",
      label: "Token for a private manifest URL (sent as a bearer token)",
      secret: true,
    },
    syncIntervalMinutes: {
      type: "number",
      label: "Minutes between syncs",
      default: 30,
      experimental_schema: z.number().int().min(5).max(1440),
    },
    opencodeConfigDir: {
      type: "string",
      label: "OpenCode configuration directory (empty: OpenCode's default)",
      default: "",
      experimental_schema: opencodeConfigDirSchema,
    },
    secretStore: {
      type: "select",
      label: "Where secrets are stored",
      options: ["auto", "file"],
      experimental_optionLabels: { auto: "Operating system credential store", file: "Private file (0600)" },
      default: "auto",
    },
    paused: { type: "boolean", label: "Pause syncing", default: false },
  });

  const kv = bb.storage.kv;
  let store: SecretStore = openSecretStore((await settings.get()).secretStore as SecretStorePreference);
  let syncing: Promise<void> | null = null;
  let rerun: SyncReport["trigger"] | null = null;
  let wake: (() => void) | null = null;
  let nextSyncAt: string | null = null;
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());

  async function readSettings(): Promise<FleetKitSettings & { secretStore: SecretStorePreference }> {
    const value = await settings.get();
    return {
      manifestUrl: value.manifestUrl,
      manifestToken: typeof value.manifestToken === "string" && value.manifestToken !== "" ? value.manifestToken : undefined,
      syncIntervalMinutes: value.syncIntervalMinutes,
      opencodeConfigDir: value.opencodeConfigDir.trim(),
      paused: value.paused,
      secretStore: value.secretStore as SecretStorePreference,
    };
  }

  function publish() {
    bb.realtime.publish(STATUS_CHANNEL, { at: Date.now() });
  }

  async function secretsStatus(): Promise<Status["secrets"]> {
    const stored = (await kv.get<StoredSecrets>("secrets")) ?? { list: [] };
    const result: Status["secrets"] = [];
    for (const secret of stored.list) {
      let set = false;
      try {
        set = await store.has(secret.name);
      } catch {
        set = false;
      }
      result.push({ ...secret, set });
    }
    return result;
  }

  async function status(): Promise<Status> {
    const current = await readSettings();
    let manifestUrl = current.manifestUrl;
    try {
      if (manifestUrl !== "") manifestUrl = parseManifestLocation(manifestUrl).display;
    } catch {
      // Show the raw value; the sync reports why it is invalid.
    }
    const opencode = (await kv.get<OpenCodeStatus>("opencode")) ?? null;
    if (opencode?.configFile) opencode.lock = await lockState(opencode.configFile).catch(() => null);
    return {
      manifestUrl,
      configured: current.manifestUrl.trim() !== "",
      paused: current.paused,
      syncing: syncing !== null,
      intervalMinutes: current.syncIntervalMinutes,
      nextSyncAt: current.paused ? null : nextSyncAt,
      lastSync: (await kv.get<SyncReport>("lastSync")) ?? null,
      secretStore: store.label,
      secrets: await secretsStatus(),
      opencode,
      notices: (await kv.get<Notice[]>("notices")) ?? [],
    };
  }

  async function syncOnce(trigger: SyncReport["trigger"]): Promise<void> {
    const current = await readSettings();
    if (current.manifestUrl.trim() === "") return;
    const managed = (await kv.get<ManagedState>("managed")) ?? emptyManaged();
    const environment: NodeJS.ProcessEnv = { ...process.env };
    if (current.opencodeConfigDir !== "") environment.OPENCODE_CONFIG_DIR = current.opencodeConfigDir;
    const outcome = await runSync(
      { sdk: bb.sdk, log: bb.log, settings: current, store, managed, signal: controller.signal, environment, bbConfigDir: process.env.OPENCODE_CONFIG_DIR },
      trigger,
    );
    await kv.set("managed", outcome.managed);
    await kv.set("lastSync", outcome.report);
    if (outcome.opencode !== null || outcome.manifest !== null) await kv.set("opencode", outcome.opencode);
    if (outcome.manifest !== null) {
      await kv.set("secrets", {
        list: outcome.manifest.secrets.map((secret) => ({ name: secret.name, title: secret.title, hint: secret.hint ?? null })),
      } satisfies StoredSecrets);
    }
    if (outcome.notices.length > 0) {
      const notices = (await kv.get<Notice[]>("notices")) ?? [];
      await kv.set("notices", [...notices, ...outcome.notices].slice(-20));
    }
    const errors = outcome.report.steps.filter((step) => step.outcome === "error").length;
    bb.log.info(`sync (${trigger}): ${outcome.report.outcome}, ${outcome.report.steps.length} steps, ${errors} errors`);
    if (outcome.selfUpdate) {
      // Last: the update restarts Fleet Kit, and the new version syncs on start.
      try {
        await bb.sdk.plugins.experimental_startUpdate({ pluginId: SELF_ID });
      } catch (error) {
        bb.log.warn(`could not start the Fleet Kit update: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Single flight: a request during a sync runs one more sync after it. */
  function requestSync(trigger: SyncReport["trigger"]): Promise<void> {
    if (syncing !== null) {
      rerun = trigger;
      return syncing;
    }
    syncing = (async () => {
      let next: SyncReport["trigger"] | null = trigger;
      try {
        while (next !== null && !controller.signal.aborted) {
          rerun = null;
          publish();
          try {
            await syncOnce(next);
          } catch (error) {
            bb.log.error(`sync failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          next = rerun;
        }
      } finally {
        syncing = null;
        publish();
      }
    })();
    return syncing;
  }

  settings.onChange((next, previous) => {
    if (next.secretStore !== previous.secretStore) store = openSecretStore(next.secretStore as SecretStorePreference);
    const relevant =
      next.manifestUrl !== previous.manifestUrl ||
      next.opencodeConfigDir !== previous.opencodeConfigDir ||
      next.syncIntervalMinutes !== previous.syncIntervalMinutes ||
      next.paused !== previous.paused ||
      next.secretStore !== previous.secretStore;
    if (!relevant) return;
    if (!next.paused) void requestSync("settings");
    wake?.();
    publish();
  });

  bb.background.service("sync", {
    async start(signal) {
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake = null;
            resolve();
          }
          wake = done;
          signal.addEventListener("abort", done, { once: true });
        });
      await sleep(START_DELAY_MS);
      let trigger: SyncReport["trigger"] = "start";
      while (!signal.aborted) {
        const current = await readSettings();
        if (!current.paused) await requestSync(trigger);
        trigger = "schedule";
        const delay = current.syncIntervalMinutes * 60_000;
        nextSyncAt = new Date(Date.now() + delay).toISOString();
        await sleep(delay);
      }
    },
  });

  // OpenCode launched by this bb reads Fleet Kit's directory when one is set,
  // so another bb on the same machine keeps its own OpenCode configuration.
  bb.providers.experimental_contributeEnv("acp-opencode", async () => {
    const { opencodeConfigDir } = await readSettings();
    if (opencodeConfigDir === "") return [];
    return [{ name: "OPENCODE_CONFIG_DIR", value: opencodeConfigDir, reason: "Fleet Kit keeps this bb's OpenCode configuration in its own directory" }];
  });

  async function setSecret(name: string, value: string) {
    const known = ((await kv.get<StoredSecrets>("secrets")) ?? { list: [] }).list.some((secret) => secret.name === name);
    if (!known) throw new Error(`The build does not declare a secret named ${name}.`);
    await store.set(name, checkSecretValue(value));
    publish();
    void requestSync("manual");
  }

  async function clearSecret(name: string) {
    const removed = await store.delete(name);
    publish();
    return removed;
  }

  bb.rpc.register(rpcContract, {
    status: () => status(),
    sync_now: async () => {
      const started = syncing === null;
      void requestSync("manual");
      return { started };
    },
    secret_set: async ({ name, value }) => {
      await setSecret(name, value);
      return { set: true };
    },
    secret_clear: async ({ name }) => ({ removed: await clearSecret(name) }),
    notice_dismiss: async ({ id }) => {
      const notices = (await kv.get<Notice[]>("notices")) ?? [];
      const remaining = notices.filter((notice) => notice.id !== id);
      await kv.set("notices", remaining);
      publish();
      return { dismissed: remaining.length !== notices.length };
    },
    lock_reset: async () => {
      const current = await readSettings();
      const location = resolveOpenCodeLocation({ opencodeConfigDir: current.opencodeConfigDir, environment: process.env });
      const reset = await resetStuckLock(location.configFile);
      if (reset) void requestSync("manual");
      publish();
      return { reset };
    },
  });

  const summary = (report: SyncReport | null) => {
    if (report === null) return "No sync yet.";
    const lines = [
      `${report.build ? `${report.build.name} ${report.build.version}` : "No valid manifest"}: ${report.outcome} (${report.trigger}, ${report.finishedAt})`,
    ];
    for (const step of report.steps) {
      if (step.outcome === "ok" || step.outcome === "skipped") continue;
      lines.push(`  ${step.outcome.padEnd(7)} ${step.area}/${step.item}: ${step.message}`);
    }
    return lines.join("\n");
  };

  bb.cli.register(
    defineCli({
      name: "fleet-kit",
      summary: "Show and run Fleet Kit's build sync, and store build secrets",
      commands: {
        status: cliCommand({
          summary: "Show the build version, the last sync, OpenCode protection and secrets",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run(input) {
            const value = await status();
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
            const lines = [
              `Manifest: ${value.configured ? value.manifestUrl : "not set (bb plugin config fleet-kit set manifestUrl <address>)"}`,
              `Syncing: ${value.paused ? "paused" : `every ${value.intervalMinutes} min`}${value.syncing ? " (running now)" : ""}`,
              summary(value.lastSync),
            ];
            if (value.opencode) {
              lines.push(
                `OpenCode: ${value.opencode.installed ? value.opencode.version : "not installed"}; models: ${value.opencode.models.state} (${value.opencode.protection})`,
              );
            }
            for (const secret of value.secrets) lines.push(`Secret ${secret.name}: ${secret.set ? "set" : "not set"} (${value.secretStore})`);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        sync: cliCommand({
          summary: "Sync with the manifest now and wait for the result",
          options: { json: { type: "boolean", description: "Print the report as JSON" } },
          async run(input) {
            const current = await readSettings();
            if (current.manifestUrl.trim() === "") {
              throw new PluginCliError("manifestUrl is not set", {
                code: "not_configured",
                hint: "Run `bb plugin config fleet-kit set manifestUrl <address>`.",
              });
            }
            await requestSync("manual");
            const report = (await kv.get<SyncReport>("lastSync")) ?? null;
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
            return { exitCode: report?.outcome === "error" ? 1 : 0, stdout: summary(report) };
          },
        }),
        "secret set": cliCommand({
          summary: "Store a build secret in the operating system's credential store",
          positionals: [{ name: "name", description: "Secret name from the manifest's secrets list", required: true }],
          options: {
            value: {
              type: "string",
              stdin: true,
              required: true,
              description: "The secret value; pipe it with --value-stdin so it stays out of process arguments",
            },
          },
          async run(input) {
            const name = input.positionals.name;
            if (!SECRET_NAME.test(name)) throw new PluginCliError(`invalid secret name ${name}`, { code: "invalid_name" });
            try {
              await setSecret(name, input.options.value);
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "secret_not_stored" });
            }
            return { exitCode: 0, stdout: `Stored ${name} in ${store.label}.` };
          },
        }),
        "secret clear": cliCommand({
          summary: "Delete a build secret from the credential store",
          positionals: [{ name: "name", description: "Secret name", required: true }],
          async run(input) {
            const removed = await clearSecret(input.positionals.name);
            return { exitCode: 0, stdout: removed ? `Deleted ${input.positionals.name}.` : `${input.positionals.name} was not set.` };
          },
        }),
      },
    }),
  );
}
