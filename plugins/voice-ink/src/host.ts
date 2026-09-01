// The `bb.host` entry: it owns the recognition worker on the machine bb runs
// on, and answers both bb's own voice service (the built-in microphone button)
// and the plugin's streaming methods (its own button).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  experimental_aiServicesHostContract,
  type ExperimentalAiInferenceCompleteOutput,
  type ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import { voiceHostContract, type EngineStatus, type TranscriptionResult } from "../contract.js";
import { WhisperEngine } from "./whisper-engine.js";
import { WORKER_SOURCE } from "./worker-source.js";

/** The AI service id this plugin registers; every call carries it. */
export const VOICE_INK_SERVICE_ID = "voice-ink";

/** Both contracts are plain method records, so one entry serves them together. */
const hostContract = defineRpcContract({
  ...experimental_aiServicesHostContract,
  ...voiceHostContract,
});

/** A streamed segment is short, but a cold model still has to load first. */
const SEGMENT_TIMEOUT_MS = 600_000;
/** Leaves the caller room to hear our answer before its own deadline fires. */
const TIMEOUT_GRACE_MS = 500;

interface HostPaths {
  readonly dataDir: string;
  readonly tempDir: string;
}

interface HostContext {
  readonly lifecycle: { readonly signal: AbortSignal };
  readonly experimental_paths: HostPaths;
  experimental_retainWorker(): { dispose(): Promise<void> };
}

let engine: WhisperEngine | null = null;
let preparing: Promise<WhisperEngine> | null = null;
/**
 * Worker retention has to be requested from the call that is running now: a
 * lease taken through a finished call's context is rejected, and the engine
 * outlives any single call.
 */
let activeContext: HostContext | null = null;

async function engineFor(context: HostContext): Promise<WhisperEngine> {
  activeContext = context;
  if (engine !== null) return engine;
  if (preparing !== null) return preparing;

  preparing = (async () => {
    const { dataDir, tempDir } = context.experimental_paths;
    await mkdir(dataDir, { recursive: true });
    // Rewritten every time the worker starts, so a plugin update always runs
    // its own Python and never a stale copy from an earlier install.
    const workerScript = join(dataDir, "worker.py");
    await writeFile(workerScript, WORKER_SOURCE, "utf8");

    const created = new WhisperEngine({
      dataDir,
      tempDir,
      workerScript,
      idleUnloadMs: 20 * 60_000,
      log: (message, fields) => {
        console.log(`[voice-ink] ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
      },
      retainWorker: () => (activeContext ?? context).experimental_retainWorker(),
    });
    context.lifecycle.signal.addEventListener(
      "abort",
      () => {
        void created.dispose();
        engine = null;
      },
      { once: true },
    );
    engine = created;
    return created;
  })().finally(() => {
    preparing = null;
  });

  return preparing;
}

function serviceMismatch(serviceId: string): { ok: false; code: "request_failed"; message: string } {
  return {
    ok: false,
    code: "request_failed",
    message: `This plugin serves no AI service "${serviceId}".`,
  };
}

type VoiceFailureCode = Extract<ExperimentalAiVoiceTranscribeOutput, { ok: false }>["code"];

const VOICE_FAILURE_CODES: readonly VoiceFailureCode[] = [
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
];

function toVoiceOutput(
  model: string,
  result: TranscriptionResult,
): ExperimentalAiVoiceTranscribeOutput {
  if (result.ok) return { ok: true, model, text: result.text };
  const code = VOICE_FAILURE_CODES.find((candidate) => candidate === result.code);
  return {
    ok: false,
    code: code ?? "service_unavailable",
    message: result.message,
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    "ai.inference.complete": (input): ExperimentalAiInferenceCompleteOutput => ({
      ok: false,
      code: "request_failed",
      message: `voice-ink transcribes speech; it serves no inference for "${input.serviceId}".`,
    }),

    "ai.voice.transcribe": async (input, context): Promise<ExperimentalAiVoiceTranscribeOutput> => {
      if (input.serviceId !== VOICE_INK_SERVICE_ID) return serviceMismatch(input.serviceId);
      const active = await engineFor(context as HostContext);
      const result = await active.transcribe({
        audioBase64: input.audioBase64,
        mimeType: input.mimeType,
        language: null,
        prompt: input.prompt,
        timeoutMs: Math.max(1_000, input.timeoutMs - TIMEOUT_GRACE_MS),
      });
      return toVoiceOutput(input.model, result);
    },

    "voice.configure": async ({ config }, context): Promise<EngineStatus> => {
      const active = await engineFor(context as HostContext);
      return active.configure(config);
    },

    "voice.status": async ({ warmUp }, context): Promise<EngineStatus> => {
      const active = await engineFor(context as HostContext);
      return warmUp ? active.warmUp() : active.status();
    },

    "voice.transcribeSegment": async (input, context): Promise<TranscriptionResult> => {
      const active = await engineFor(context as HostContext);
      return active.transcribe({
        audioBase64: input.audioBase64,
        mimeType: input.mimeType,
        language: input.language,
        prompt: null,
        timeoutMs: SEGMENT_TIMEOUT_MS,
      });
    },
  },
  dispose: async () => {
    await engine?.dispose();
    engine = null;
  },
});
