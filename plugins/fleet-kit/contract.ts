// RPC contract between the Fleet Kit backend and its panel. The panel imports
// types only; the schemas validate every call at the server boundary.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const stepSchema = z.object({
  area: z.enum(["manifest", "bb", "marketplace", "plugin", "opencode", "secret"]),
  item: z.string(),
  outcome: z.enum(["ok", "changed", "skipped", "warning", "error"]),
  message: z.string(),
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
  kind: z.enum(["reinstalled"]),
  message: z.string(),
  at: z.string(),
});
export type Notice = z.infer<typeof noticeSchema>;

export const opencodeStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  configFile: z.string().nullable(),
  /** Which layer limits OpenCode to the allowed providers. */
  protection: z.enum(["system-policy", "user-setting", "none", "unknown"]),
  /** Result of `opencode models` against the effective configuration. */
  models: z.object({ state: z.enum(["verified", "blocked", "unrestricted", "unchecked"]), message: z.string() }),
  allowedProviders: z.array(z.string()),
  defaultModel: z.string().nullable(),
  lock: z.object({ owner: z.string(), since: z.string() }).nullable(),
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
});
export type Status = z.infer<typeof statusSchema>;

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
});
