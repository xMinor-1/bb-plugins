// Contracts shared by the three sides of voice-ink: the app (browser), the
// server factory, and the host entry that owns the speech-recognition worker.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** A file the plugin downloads: where from, and the SHA-256 it must have. */
export const assetSpecSchema = z.object({ url: z.string(), sha256: z.string() }).strict();
export type AssetSpecConfig = z.infer<typeof assetSpecSchema>;

/** What the whisper.cpp engine downloads; the host picks the program for its own platform. */
export const whisperCppConfigSchema = z
  .object({
    /** A ggml model file. */
    model: assetSpecSchema,
    /** Zip archives with whisper-server, keyed by `<process.platform>-<process.arch>`. */
    runtimes: z.record(z.string(), assetSpecSchema.nullable()),
    /** `Name: value` sent with the downloads to their own origin, or null. */
    authHeader: z.string().nullable(),
  })
  .strict();
export type WhisperCppConfig = z.infer<typeof whisperCppConfigSchema>;

export const ENGINES = ["faster-whisper", "whisper.cpp"] as const;
export type EngineKind = (typeof ENGINES)[number];

/** How the worker should be run; the server owns these, the host applies them. */
export const engineConfigSchema = z
  .object({
    /** Which recognizer runs: Python with faster-whisper, or whisper.cpp's server. */
    engine: z.enum(ENGINES).default("faster-whisper"),
    /** Downloads for the whisper.cpp engine; null when the other engine is chosen. */
    whisperCpp: whisperCppConfigSchema.nullable().default(null),
    /** faster-whisper model name or a local CTranslate2 directory. */
    model: z.string().min(1),
    /** CTranslate2 quantization; int8 is the only one that keeps CPU usable. */
    computeType: z.string().min(1),
    /** Compute threads per recognition pass. */
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
    /** How many pieces of a long recording are recognized side by side. */
    parallel: z.number().int().positive().max(8),
    /** Restore punctuation, sentence boundaries and capitalization locally. */
    punctuate: z.boolean(),
    /** A pause at least this long starts a new paragraph. */
    paragraphPauseSec: z.number().positive(),
    /** How much dictation history is kept on disk, and whether any is. */
    history: z
      .object({
        enabled: z.boolean(),
        /** Entries above this count are dropped, oldest first; 0 means no cap. */
        maxEntries: z.number().int().nonnegative().max(10_000),
        /** Entries older than this are dropped; 0 means no age limit. */
        maxAgeDays: z.number().int().nonnegative().max(3_650),
      })
      .strict()
      // Defaulted, not required: a config.json written by an older version
      // must keep working, or an update would silently reset the model choice.
      .default({ enabled: true, maxEntries: 200, maxAgeDays: 30 }),
    /** Language model that turns the raw transcript into written text. */
    polish: z
      .object({
        provider: z.enum(["off", "groq", "anthropic", "openai-compatible"]),
        apiKey: z.string().nullable(),
        model: z.string(),
        baseUrl: z.string().nullable(),
        extraInstruction: z.string().nullable(),
      })
      .strict(),
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
      /** True when this is only what had been recognized when time ran out. */
      partial: z.boolean().optional(),
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
    engine: z.enum(ENGINES),
    model: z.string().nullable(),
    pythonPath: z.string().nullable(),
    /** The whisper.cpp server program, once it is downloaded. */
    runtimePath: z.string().nullable(),
    /**
     * Whether a dictation could start now without a download: Python found, or
     * the whisper.cpp program and model checked. The model may still need loading.
     */
    assetsReady: z.boolean(),
    /** A download in progress, for the status line and the setup page. */
    download: z
      .object({ label: z.string(), doneBytes: z.number(), totalBytes: z.number().nullable() })
      .strict()
      .nullable(),
    message: z.string().nullable(),
  })
  .strict();
export type EngineStatus = z.infer<typeof engineStatusSchema>;

/** One dictation as the History panel shows it: the audio and its transcript. */
export const historyEntrySchema = z
  .object({
    id: z.string(),
    /** When the recording arrived, in epoch milliseconds. */
    createdAt: z.number(),
    status: z.enum(["running", "done", "failed"]),
    text: z.string(),
    model: z.string(),
    /** Which button produced it: bb's own microphone, or the plugin's. */
    source: z.enum(["voice", "segment"]),
    durationSec: z.number().nullable(),
    elapsedSec: z.number().nullable(),
    /**
     * How many characters the caller got. Shorter than `text` means bb stopped
     * waiting and only part of this reached the composer.
     */
    deliveredChars: z.number().nullable(),
    audioFile: z.string().nullable(),
    audioBytes: z.number(),
    mimeType: z.string(),
    audioDigest: z.string(),
    error: z.string().nullable(),
  })
  .strict();
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyPolicySchema = z
  .object({
    enabled: z.boolean(),
    maxEntries: z.number().int().nonnegative().max(10_000),
    maxAgeDays: z.number().int().nonnegative().max(3_650),
  })
  .strict();
export type HistoryPolicy = z.infer<typeof historyPolicySchema>;

const historyListInput = z
  .object({
    query: z.string(),
    limit: z.number().int().positive().max(200),
    offset: z.number().int().nonnegative(),
  })
  .strict();

const historyListOutput = z
  .object({ entries: z.array(historyEntrySchema), total: z.number() })
  .strict();

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
  "voice.last": {
    input: z.object({}).strict(),
    output: z.object({ text: z.string().nullable() }).strict(),
  },
  "voice.history.list": { input: historyListInput, output: historyListOutput },
  "voice.history.get": {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ entry: historyEntrySchema.nullable() }).strict(),
  },
  "voice.history.audio": {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({ mimeType: z.string(), audioBase64: z.string() })
      .strict()
      .nullable(),
  },
  "voice.history.delete": {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  "voice.history.clear": {
    input: z.object({}).strict(),
    output: z.object({ removed: z.number() }).strict(),
  },
  /**
   * One whole recording from bb's own microphone button, answered within the
   * time bb waits. The recording is filed in history before recognition starts.
   */
  "voice.transcribeRecording": {
    input: z
      .object({
        audioBase64: z.string().min(1),
        mimeType: z.string().min(1),
        /** Vocabulary bb passes along for this recording, or null. */
        prompt: z.string().nullable(),
        /** What is left of bb's wait when the host gets the recording. */
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.union([
      z.object({ ok: z.literal(true), text: z.string() }).strict(),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }).strict(),
    ]),
  },
  /** One filler sentence from the quick voice (src/quick-voice.ts). */
  "voice.quick": {
    input: z
      .object({
        prompt: z.string().min(1).max(8_000),
        model: z.string().min(1),
        claudePath: z.string().nullable(),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.union([
      z
        .object({
          ok: z.literal(true),
          text: z.string(),
          firstTokenMs: z.number().nullable(),
          totalMs: z.number(),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          code: z.enum(["busy", "unavailable", "timeout", "failed"]),
          message: z.string(),
        })
        .strict(),
    ]),
  },
  "voice.quick.warm": {
    input: z.object({ model: z.string().min(1), claudePath: z.string().nullable() }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
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

export const speakResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      audioBase64: z.string(),
      mimeType: z.string(),
      /** Time the speech service spent synthesizing, and the audio it made. */
      synthMs: z.number().nullable(),
      audioMs: z.number().nullable(),
      /** The text after the service turned digits and Latin into words. */
      spokenText: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      /** "empty" means nothing pronounceable was left; skip it, it is not an error. */
      code: z.enum(["empty", "loading", "unreachable", "failed"]),
      message: z.string(),
    })
    .strict(),
]);
export type SpeakResult = z.infer<typeof speakResultSchema>;

const clipSchema = z
  .object({ text: z.string(), audioBase64: z.string(), mimeType: z.string() })
  .strict();
export type SpokenClip = z.infer<typeof clipSchema>;

export const quickReplyResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      text: z.string(),
      /** From the request to the quick voice's whole sentence. */
      quickMs: z.number(),
      clip: clipSchema,
    })
    .strict(),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }).strict(),
]);
export type QuickReplyResult = z.infer<typeof quickReplyResultSchema>;

export const conversationConfigSchema = z
  .object({
    /** Silence after speech that ends the user's turn. */
    endOfSpeechMs: z.number().int().positive(),
    /** Stop speaking when the user starts talking over the reply. */
    bargeIn: z.boolean(),
    /** Appended to every message sent from conversation mode, or "" for none. */
    marker: z.string(),
    /** A small model says one sentence while the agent is still thinking. */
    quickVoice: z.boolean(),
  })
  .strict();
export type ConversationConfig = z.infer<typeof conversationConfigSchema>;

/**
 * Milliseconds from the moment the user stopped talking; null when the step
 * did not happen (no reply text, nothing spoken, the user interrupted).
 */
export const conversationTimingSchema = z
  .object({
    at: z.number(),
    threadId: z.string(),
    /** Words in the user's phrase and characters in the reply. */
    words: z.number().int().nonnegative(),
    replyChars: z.number().int().nonnegative(),
    transcribedMs: z.number().nullable(),
    submittedMs: z.number().nullable(),
    firstTextMs: z.number().nullable(),
    firstSentenceMs: z.number().nullable(),
    firstAudioMs: z.number().nullable(),
    playingMs: z.number().nullable(),
    turnDoneMs: z.number().nullable(),
    /** The instant "mm-hm" when the pause was detected. */
    ackMs: z.number().nullable(),
    /** The quick voice: its sentence written, and heard. */
    quickTextMs: z.number().nullable(),
    quickPlayingMs: z.number().nullable(),
    /** Synthesis time of the first sentence as the speech service reported it. */
    firstSynthMs: z.number().nullable(),
    sentences: z.number().int().nonnegative(),
    interrupted: z.boolean(),
  })
  .strict();
export type ConversationTiming = z.infer<typeof conversationTimingSchema>;

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
  history_list: { input: historyListInput, output: historyListOutput },
  history_delete: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  history_clear: {
    input: z.object({}).strict(),
    output: z.object({ removed: z.number() }).strict(),
  },
  /** One sentence of the agent's reply, spoken by the local speech service. */
  speak: {
    input: z.object({ text: z.string().min(1).max(4_000) }).strict(),
    output: speakResultSchema,
  },
  /** Conversation-mode settings the browser needs before it starts listening. */
  conversation_config: {
    input: z.object({}).strict(),
    output: conversationConfigSchema,
  },
  /** The quick voice's sentence for the phrase just sent, already spoken. */
  quick_reply: {
    input: z
      .object({
        text: z.string().min(1).max(4_000),
        recent: z
          .array(z.object({ who: z.enum(["user", "agent"]), text: z.string().max(2_000) }).strict())
          .max(12),
      })
      .strict(),
    output: quickReplyResultSchema,
  },
  /** Short spoken acknowledgements, synthesized once and kept. */
  fillers: {
    input: z.object({}).strict(),
    output: z.object({ ack: z.array(clipSchema), wait: z.array(clipSchema) }).strict(),
  },
  /** One exchange's timings, kept so `bb voice-ink latency` can report them. */
  conversation_log: {
    input: z.object({ entry: conversationTimingSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export { HISTORY_AUDIO_ROUTE, HISTORY_AUDIO_URL, PANEL_PATH } from "./src/shared/paths.js";
