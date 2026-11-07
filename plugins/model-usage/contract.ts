// The two wires of the plugin: panel ↔ server (rpcContract) and server ↔ the
// machine where OpenCode runs (hostContract). The panel imports types only.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LimitsSnapshot, TokensSnapshot } from "./src/shared/types";
import type { ScanStatus, UsageSummary } from "./src/claude/usage-scan";

const freshness = z.object({
  /** Figures older than this are collected again; 0 means always. */
  maxAgeMs: z.number().int().nonnegative(),
  /** A press of Refresh: ask the providers themselves, not their caches. */
  force: z.boolean(),
});

export const rpcContract = defineRpcContract({
  limits: {
    input: freshness,
    output: z.custom<LimitsSnapshot>(),
  },
  tokens: {
    input: freshness,
    output: z.custom<TokensSnapshot>(),
  },
  activity: {
    input: z.object({ window: z.enum(["5h", "24h", "7d"]) }),
    output: z.custom<UsageSummary>(),
  },
  scanStatus: {
    input: z.null(),
    output: z.custom<ScanStatus>(),
  },
});

const rowSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  bucket: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
  requests: z.number(),
});

export const hostContract = defineRpcContract({
  readOpencode: {
    input: z.object({ now: z.number().int().nonnegative() }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), dbPath: z.string(), schema: z.enum(["v1", "v2", "mixed"]), rows: z.array(rowSchema) }),
      z.object({ status: z.literal("not_found"), dbPath: z.null(), schema: z.null(), rows: z.tuple([]) }),
      z.object({ status: z.literal("error"), dbPath: z.string().nullable(), schema: z.null(), rows: z.tuple([]), message: z.string() }),
    ]),
    // A read of a local file: safe to send again if the first answer is late.
    experimental_retryable: true,
  },
});
