// The contract between the server entry and the host entry.
//
// The host entry runs on the person's machine: the one where the agent runs
// and that can reach the company's MCP servers (often only inside the
// corporate network). It keeps the list of servers, their tokens (in the OS
// credential store), writes OpenCode's configuration and checks that each
// server answers. The server entry keeps no tokens: it passes the panel's
// requests on, schedules checks and offers the agent tools.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { opencodeConfigDirSchema } from "./src/shared/settings.js";

/** Names as OpenCode shows them; also the key under `mcp.servers` in opencode.json. */
export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const serverNameSchema = z.string().regex(SERVER_NAME);

export const langSchema = z.enum(["en", "ru"]);
export type Lang = z.infer<typeof langSchema>;

/** What the server passes with every call that may write opencode.json. */
export const writeConfigSchema = z
  .object({
    opencodeConfigDir: opencodeConfigDirSchema,
    /** Seconds OpenCode waits for one tool call, unless a server has its own; 0 = OpenCode's default. */
    timeoutSec: z.number().int().min(0).max(600),
    /**
     * The bb server's own environment, sent only to the bb server's own
     * machine. bb starts host workers with a trimmed environment and a PATH
     * rebuilt with the login shell's entries first, while the server and Fleet
     * Kit see bb's own. Without these the plugin would write a different
     * opencode.json than Fleet Kit, or judge a different OpenCode.
     */
    serverEnvironment: z
      .object({
        OPENCODE_CONFIG_DIR: z.string().max(4000).optional(),
        XDG_CONFIG_HOME: z.string().max(4000).optional(),
        PATH: z.string().max(32_000).optional(),
      })
      .strict(),
    /** The template catalog that names servers ("" or absent: none). */
    catalogUrl: z.string().max(2000).optional(),
    /** Development only (BB_MCP_CATALOG_ALLOW_HTTP=1 in bb's environment): plain http for local stubs. */
    allowHttp: z.boolean().optional(),
  })
  .strict();
export type WriteConfig = z.infer<typeof writeConfigSchema>;

export const HEALTH = ["unknown", "ok", "down", "unauthorized"] as const;
export const healthStatusSchema = z.enum(HEALTH);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const healthSchema = z
  .object({
    status: healthStatusSchema,
    /** When the server took its current status (ms). */
    since: z.number().nullable(),
    /** The last check (ms). */
    checkedAt: z.number().nullable(),
    /** Short technical reason for down/unauthorized: "HTTP 502", "timeout", "connection refused". Never a token. */
    detail: z.string().max(300).nullable(),
    /** Tools the server listed on the last good check. */
    tools: z.number().int().nullable(),
  })
  .strict();
export type Health = z.infer<typeof healthSchema>;

export const serverViewSchema = z
  .object({
    /** The id: the key under `mcp.servers` in opencode.json, and what OpenCode shows. */
    name: z.string(),
    /** A name for people: the platform template's, else the server's own, else the id made readable. */
    title: z.string(),
    /** One line of what the server does, or null when nothing says. */
    summary: z.string().nullable(),
    /** Host and path with id-like parts shortened (maskAddress); the full address never leaves the machine. */
    address: z.string(),
    enabled: z.boolean(),
    /** This server's own call timeout (s), or null for the plugin's default. */
    timeoutSec: z.number().int().nullable(),
    /** Header names only; values never leave the machine. */
    headers: z.array(z.string()),
    /** Headers whose value lives in the OS store. */
    secretHeaders: z.array(z.string()),
    /** opencode.json already has a server by this name that this plugin did not write. */
    conflict: z.boolean(),
    addedAt: z.number(),
    health: healthSchema,
  })
  .strict();
export type ServerView = z.infer<typeof serverViewSchema>;

export const statusSchema = z
  .object({
    servers: z.array(serverViewSchema),
    /** The opencode.json this machine writes. */
    configFile: z.string().nullable(),
    /** Why the last write of opencode.json failed: "[mcp:<code>] English text". */
    configError: z.string().nullable(),
    /** Where tokens live, for display: "macOS Keychain", "Windows Credential Manager", "file (…)". */
    store: z.string(),
  })
  .strict();
export type Status = z.infer<typeof statusSchema>;

export const SKIP_REASONS = [
  "local",
  "no-url",
  "bad-url",
  "insecure-url",
  "url-secret",
  "reference",
  "bad-name",
  "bad-headers",
  "duplicate",
] as const;
export const skipSchema = z.object({ name: z.string(), reason: z.enum(SKIP_REASONS) }).strict();
export type Skip = z.infer<typeof skipSchema>;

export const importResultSchema = z
  .object({
    added: z.array(z.string()),
    updated: z.array(z.string()),
    skipped: z.array(skipSchema),
    status: statusSchema,
  })
  .strict();
export type ImportResult = z.infer<typeof importResultSchema>;

export const catalogItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    category: z.string().nullable(),
  })
  .strict();
export type CatalogItem = z.infer<typeof catalogItemSchema>;

const config = writeConfigSchema;

export const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: statusSchema },
  importConfig: {
    input: z.object({ text: z.string().min(1).max(200_000), config }).strict(),
    output: importResultSchema,
  },
  setEnabled: {
    input: z.object({ name: serverNameSchema, enabled: z.boolean(), replace: z.boolean().optional(), config }).strict(),
    output: statusSchema,
  },
  setTimeout: {
    input: z.object({ name: serverNameSchema, timeoutSec: z.number().int().min(1).max(600).nullable(), config }).strict(),
    output: statusSchema,
  },
  remove: { input: z.object({ name: serverNameSchema, config }).strict(), output: statusSchema },
  /** Check servers whose last check is older than maxAgeMs (all of them by default), at most a few at a time. */
  check: {
    input: z.object({ names: z.array(serverNameSchema).max(200).optional(), maxAgeMs: z.number().int().min(0).optional(), config }).strict(),
    output: statusSchema,
  },
  /** Write opencode.json again from the saved list, after a setting changed or a write failed. */
  sync: { input: z.object({ config }).strict(), output: statusSchema },
});
