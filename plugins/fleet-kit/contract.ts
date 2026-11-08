// RPC contract between the Fleet Kit backend and its panel. The panel imports
// types only; the schemas validate every call at the server boundary.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** A text from src/shared/texts.ts: the panel shows it in the person's language; `message` is the English copy. */
const textFields = {
  message: z.string(),
  code: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
};

export const stepSchema = z.object({
  area: z.enum(["manifest", "bb", "ai", "agent", "marketplace", "plugin", "opencode", "secret"]),
  item: z.string(),
  outcome: z.enum(["ok", "changed", "skipped", "warning", "error"]),
  ...textFields,
});
export type Step = z.infer<typeof stepSchema>;

export const syncReportSchema = z.object({
  trigger: z.enum(["start", "schedule", "manual", "settings"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  outcome: z.enum(["ok", "changed", "warning", "error"]),
  build: z.object({ name: z.string(), version: z.string() }).nullable(),
  /** The manifest uses a format this Fleet Kit does not read; only its own update applied. */
  fleetKitOutdated: z.boolean().optional(),
  steps: z.array(stepSchema),
});
export type SyncReport = z.infer<typeof syncReportSchema>;

export const noticeSchema = z.object({
  id: z.string(),
  kind: z.enum(["reinstalled", "agent-disabled"]),
  at: z.string(),
  ...textFields,
});
export type Notice = z.infer<typeof noticeSchema>;

export const opencodeStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  /** Fleet Kit's own OpenCode: where it stands. Absent when this machine does not get one. */
  install: z
    .object({
      state: z.enum(["ready", "installing", "failed", "denied"]),
      path: z.string(),
      code: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number()])),
      message: z.string(),
    })
    .nullable()
    .optional(),
  configFile: z.string().nullable(),
  /** Which layer limits OpenCode to the allowed providers. */
  protection: z.enum(["system-policy", "user-setting", "none", "unknown"]),
  /** Result of `opencode models` against the effective configuration. */
  models: z.object({ state: z.enum(["verified", "blocked", "unrestricted", "unchecked"]), message: z.string() }),
  allowedProviders: z.array(z.string()),
  defaultModel: z.string().nullable(),
  lock: z.object({ owner: z.string(), since: z.string(), resetAfter: z.string().optional() }).nullable(),
});
export type OpenCodeStatus = z.infer<typeof opencodeStatusSchema>;

export const secretStatusSchema = z.object({
  name: z.string(),
  title: z.string(),
  hint: z.string().nullable(),
  set: z.boolean(),
});

export const statusSchema = z.object({
  manifestUrl: z.string(),
  configured: z.boolean(),
  paused: z.boolean(),
  syncing: z.boolean(),
  intervalMinutes: z.number(),
  nextSyncAt: z.string().nullable(),
  lastSync: syncReportSchema.nullable(),
  secretStore: z.string(),
  secrets: z.array(secretStatusSchema),
  opencode: opencodeStatusSchema.nullable(),
  notices: z.array(noticeSchema),
  /** The build's offer of the person's own agents; null when the build has none. */
  ownAgents: z
    .object({
      title: z.string().nullable(),
      warning: z.string(),
      providers: z.array(z.object({ id: z.string(), name: z.string() })),
      delegate: z.object({ provider: z.string(), model: z.string() }).nullable(),
      on: z.boolean(),
      at: z.string().nullable(),
      /** Windows cancelled or left unanswered on this machine. */
      refusals: z.number().optional(),
      /** Until when a new window waits after the last refusal; null when it can open now. */
      retryAt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type Status = z.infer<typeof statusSchema>;

/** What turning "Own agents" on or off came to. Only `on` changed anything when turning on. */
export const ownAgentsOutcomeSchema = z.enum(["on", "off", "cancelled", "timeout", "unavailable", "busy", "paused", "not-offered"]);
export type OwnAgentsOutcome = z.infer<typeof ownAgentsOutcomeSchema>;

/**
 * `checking`: the plugin has not answered within the page's wait; its answer comes with the next update.
 * `queued`: Fleet Kit installs plugins one at a time and this one waits for its turn; `installing`: it is being installed now.
 */
export const setupStateSchema = z.enum(["done", "todo", "problem", "installing", "queued", "later", "checking"]);
export type SetupState = z.infer<typeof setupStateSchema>;
export const setupMarkSchema = z.enum(["done", "skipped"]);
export type SetupMark = z.infer<typeof setupMarkSchema>;

/** One plugin of the shared sign-in step. `waiting`: not installed yet, it gets the sign-in once it is. */
const accountPluginSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(["done", "todo", "problem", "waiting"]),
  /** The plugin's own line, in the language of the sign-in. */
  summary: z.string().nullable(),
  /** `rejected`: the service refused the login or password; the others are Fleet Kit's. */
  reason: z.enum(["rejected", "old-version", "not-allowed", "no-answer"]).nullable(),
  path: z.string().nullable(),
});

/** A plugin that signs in in its own window, opened from the step. */
const accountWindowSchema = z.object({
  id: z.string(),
  title: z.string(),
  hint: z.string().nullable(),
  method: z.string(),
  state: z.enum(["done", "todo", "problem", "waiting", "checking"]),
  summary: z.string().nullable(),
  path: z.string().nullable(),
});

export const accountStepSchema = z.object({
  /** A login and password are in the credential store. */
  saved: z.boolean(),
  loginHint: z.string().nullable(),
  passwordHint: z.string().nullable(),
  plugins: z.array(accountPluginSchema),
  windows: z.array(accountWindowSchema),
  /** The machine a window opens on: bb's primary host. */
  hostId: z.string().nullable(),
});
export type AccountStep = z.infer<typeof accountStepSchema>;

/** One step of the "First run" page (manifest `onboarding[]`) with its state now. */
export const setupStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  hint: z.string().nullable(),
  optional: z.boolean(),
  kind: z.enum(["secret", "plugin", "account"]),
  /** The secret's name for a secret step, the plugin's id for a plugin step. */
  target: z.string(),
  state: setupStateSchema,
  /** The plugin's own line, already in the requested language. */
  summary: z.string().nullable(),
  /** Why, when Fleet Kit decided the state itself: the panel says it in the person's language. */
  reason: z.enum(["manual", "no-answer", "install-failed"]).nullable(),
  /** The bb page where the person does the step. */
  path: z.string().nullable(),
  /** The plugin cannot report its state: the person marks the step done. */
  manual: z.boolean(),
  mark: setupMarkSchema.nullable(),
  /** The shared sign-in, for an account step. */
  account: accountStepSchema.optional(),
});
export type SetupStep = z.infer<typeof setupStepSchema>;

/** The build's branches and the person's choice, for the First run page. */
export const branchSetupSchema = z.object({
  list: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      hint: z.string().nullable(),
      /** Whether the branch turns each optional plugin on: the page previews a branch before the person installs it. */
      defaults: z.record(z.string(), z.boolean()).optional(),
    }),
  ),
  /** The branch the person picked; null before a choice, or when the build dropped it. */
  chosen: z.string().nullable(),
  /** The picked branch left the build: the person's plugins stay as they were. */
  dropped: z.boolean(),
  /** Plugins that differ between branches wait on this machine until a branch is picked. */
  waiting: z.boolean(),
  /** The optional plugins: whether this machine gets each one, and what the chosen branch recommends. */
  plugins: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      hint: z.string().nullable(),
      on: z.boolean(),
      /** Waits for a branch: it differs between branches. */
      waiting: z.boolean(),
      recommended: z.boolean(),
      /** The person switched it by hand. */
      own: z.boolean(),
      /** Not built yet: shown, cannot be switched. */
      planned: z.boolean(),
    }),
  ),
});
export type BranchSetup = z.infer<typeof branchSetupSchema>;

const installItemSchema = z.object({ id: z.string(), title: z.string(), note: z.string().nullable() });

/** The plugins a sync installs, one at a time, in the manifest's order. */
export const installProgressSchema = z.object({
  startedAt: z.string(),
  /** Null while the sync is still installing. */
  finishedAt: z.string().nullable(),
  current: installItemSchema.extend({ startedAt: z.string() }).nullable(),
  queue: z.array(installItemSchema),
  /** `ok` false: the install failed or did not finish in time; the Fleet Kit page has the details. */
  done: z.array(installItemSchema.extend({ ok: z.boolean() })),
  /** Seconds the finished installs took on average; null before the first one. */
  averageSeconds: z.number().nullable(),
});
export type InstallProgress = z.infer<typeof installProgressSchema>;

export const setupSchema = z.object({
  /** Fleet Kit has read a build manifest at least once. */
  configured: z.boolean(),
  /** This machine has a manifest address: without one there will never be steps. */
  manifestSet: z.boolean(),
  steps: z.array(setupStepSchema),
  /** Steps still to do: not done, not skipped, not waiting for a plugin that is not built yet. */
  remaining: z.number().int(),
  complete: z.boolean(),
  secretStore: z.string(),
  /** OpenCode installed by Fleet Kit while it is not ready; the page says what is going on. */
  opencodeInstall: opencodeStatusSchema.shape.install,
  /** Null when the build has no branches. */
  branches: branchSetupSchema.nullable().optional(),
  /** What the current or last sync of this process installs; null when it installed nothing. */
  installs: installProgressSchema.nullable().optional(),
});
export type Setup = z.infer<typeof setupSchema>;

export const STATUS_CHANNEL = "status-changed";

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  sync_now: { input: z.null(), output: z.object({ started: z.boolean() }) },
  secret_set: {
    input: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), value: z.string().min(1).max(8192) }).strict(),
    output: z.object({ set: z.boolean() }),
  },
  secret_clear: {
    input: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  notice_dismiss: {
    input: z.object({ id: z.string().min(1).max(200) }).strict(),
    output: z.object({ dismissed: z.boolean() }),
  },
  lock_reset: { input: z.null(), output: z.object({ reset: z.boolean() }) },
  setup_status: { input: z.object({ lang: z.enum(["en", "ru"]) }).strict(), output: setupSchema },
  /** Without `confirmed`, a choice that would turn plugins off is not saved: the answer lists them for the person to confirm. */
  branch_choose: {
    input: z
      .object({
        branch: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        confirmed: z.boolean().optional(),
        /** Switches the person made while looking at the branch: saved together with it. */
        plugins: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), z.boolean()).optional(),
      })
      .strict(),
    output: z.object({ chosen: z.string().nullable(), turnsOff: z.array(z.string()) }),
  },
  branch_toggle: {
    input: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), on: z.boolean() }).strict(),
    output: z.object({ on: z.boolean() }),
  },
  /** Turning on asks the person in a system window first: a call alone changes nothing. */
  own_agents_set: {
    input: z.object({ on: z.boolean(), lang: z.enum(["en", "ru"]).optional() }).strict(),
    output: z.object({ on: z.boolean(), outcome: ownAgentsOutcomeSchema }),
  },
  /** The shared sign-in: saved in the credential store, then handed to the step's plugins. */
  account_set: {
    input: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), login: z.string().min(1).max(256), password: z.string().min(1).max(1024), lang: z.enum(["en", "ru"]).optional() }).strict(),
    output: z.object({ saved: z.boolean() }),
  },
  account_clear: {
    input: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  setup_mark: {
    input: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), mark: setupMarkSchema.nullable() }).strict(),
    output: z.object({ marked: z.boolean() }),
  },
});
