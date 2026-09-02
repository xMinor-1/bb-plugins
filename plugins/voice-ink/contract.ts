// Contracts shared by the three sides of voice-ink: the app (browser), the
// server factory, and the host entry that owns the speech-recognition worker.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** How the worker should be run; the server owns these, the host applies them. */
export const engineConfigSchema = z
  .object({
    /** faster-whisper model name or a local CTranslate2 directory. */
    model: z.string().min(1),
    /** CTranslate2 quantization; int8 is the only one that keeps CPU usable. */
    computeType: z.string().min(1),
    threads: z.number().int().positive().max(64),
    batchSize: z.number().int().positive().max(32),
    /** Spoken language, or null to let the model detect it. */
    language: z.string().min(2).max(8).nullable(),
    /** Names and terms fed to the model as context, one line of text. */
    vocabulary: z.string().nullable(),
    /** Interpreter with faster-whisper installed; null means "discover one". */
    pythonPath: z.string().nullable(),
    /** Retire the model after this long without a request; 0 keeps it loaded. */
    idleUnloadMs: z.number().int().nonnegative(),
  })
  .strict();
export type EngineConfig = z.infer<typeof engineConfigSchema>;

const transcriptionResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      text: z.string(),
      audioSec: z.number(),
      elapsedSec: z.number(),
    })
    .strict(),
  z
    .object({ ok: z.literal(false), code: z.string(), message: z.string() })
    .strict(),
]);
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;

export const engineStatusSchema = z
  .object({
    /** "ready" only once a model is loaded and a request would run now. */
    state: z.enum(["idle", "loading", "ready", "failed"]),
    model: z.string().nullable(),
    pythonPath: z.string().nullable(),
    message: z.string().nullable(),
  })
  .strict();
export type EngineStatus = z.infer<typeof engineStatusSchema>;

/**
 * The plugin's own host methods. bb's voice-service contract is merged in on
 * the host side only (src/host.ts): its module is bundled into the host
 * artifact and is not resolvable from server code.
 *
 * Segments arrive while the user is still talking, which is what keeps the
 * wait after "stop" down to the last segment.
 */
export const voiceHostContract = defineRpcContract({
  "voice.configure": {
    input: z.object({ config: engineConfigSchema }).strict(),
    output: engineStatusSchema,
  },
  "voice.status": {
    input: z.object({ warmUp: z.boolean() }).strict(),
    output: engineStatusSchema,
  },
  "voice.transcribeSegment": {
    input: z
      .object({
        audioBase64: z.string().min(1),
        /** Container hint for the decoder; audio/* or application/octet-stream. */
        mimeType: z.string().min(1),
        /** Overrides the configured language for this segment only. */
        language: z.string().min(2).max(8).nullable(),
      })
      .strict(),
    output: transcriptionResultSchema,
  },
});

/** What the browser side calls; the server relays it to the host. */
export const rpcContract = defineRpcContract({
  status: {
    input: z.object({ warmUp: z.boolean() }).strict(),
    output: engineStatusSchema,
  },
  transcribe_segment: {
    input: z
      .object({
        audioBase64: z.string().min(1),
        mimeType: z.string().min(1),
        language: z.string().min(2).max(8).nullable(),
      })
      .strict(),
    output: transcriptionResultSchema,
  },
});
