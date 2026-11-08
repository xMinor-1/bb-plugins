// RPC contract between the server and the app. The app imports its type only.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const proxyStatus = z.object({
  state: z.enum(["installing", "starting", "running", "failed", "not-configured", "stopped"]),
  message: z.string().nullable(),
  problem: z.enum(["no-source", "no-file", "download", "start"]).nullable(),
  since: z.number(),
});

const totals = z.object({
  requests: z.number(),
  tokenCounts: z.number(),
  masked: z.number(),
  direct: z.number(),
  errors: z.number(),
  lastAt: z.number().nullable(),
});

const threadStatus = z.object({
  threadId: z.string(),
  masking: z.boolean(),
  explicit: z.boolean(),
  proxy: proxyStatus,
  totals,
});

const feedEntry = z.object({
  id: z.string(),
  at: z.number(),
  path: z.string(),
  model: z.string().nullable(),
  via: z.enum(["proxy", "direct", "blocked"]),
  status: z.number().nullable(),
  durationMs: z.number().nullable(),
  masked: z.record(z.string(), z.number()).nullable(),
  maskedTotal: z.number(),
  error: z.string().nullable(),
});

const lang = z.enum(["en", "ru"]).optional();
const threadInput = z.object({ threadId: z.string().min(1).max(200), lang });

export const rpcContract = defineRpcContract({
  thread_status: { input: threadInput, output: threadStatus },
  thread_feed: {
    input: threadInput.extend({ limit: z.number().int().min(1).max(100).optional() }),
    output: z.object({ entries: z.array(feedEntry) }),
  },
  thread_set_masking: {
    input: threadInput.extend({ masking: z.boolean() }),
    output: threadStatus,
  },
  /** Fleet Kit's "First run" page asks every plugin with a setup step this. */
  setupStatus: {
    input: z.object({ lang, hostId: z.string().optional() }).nullable().optional(),
    output: z.object({
      state: z.enum(["done", "todo", "problem"]),
      summary: z.string().max(200),
      path: z.string().max(300).optional(),
    }),
  },
});

export type RpcContract = typeof rpcContract;
