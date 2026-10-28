import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { strokeSchema } from "./contract.js";

export const hostContract = defineRpcContract({
  drawing: {
    input: z.object({
      html: z.string().min(1).max(24 * 1024 * 1024),
      folder: z.string().min(1).max(32768),
      label: z.string().min(1).max(200),
      viewport: z.object({ w: z.number().min(1).max(20000), h: z.number().min(1).max(20000) }).strict(),
      scroll: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      strokes: z.array(strokeSchema(z.number().min(-1e6).max(1e7))).max(60),
    }).strict(),
    output: z.string().min(1).max(64 * 1024 * 1024),
  },
  fileVersion: {
    input: z.object({ path: z.string().min(1).max(32768) }).strict(),
    output: z.string().nullable(),
  },
});

export const hostSignals = { changed: { payload: z.object({ path: z.string() }).strict() } };
