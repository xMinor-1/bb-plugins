// voice-ink — local speech recognition for bb's chat composer.
//
// bb sends voice input to the AI service picked for it in Settings → AI
// services (or `bb settings ai-services set voice voice-ink`). This plugin
// registers one and answers it from a Whisper model running on the machine bb
// runs on: no account, no API key, no audio leaving the box.
//
// The heavy lifting happens in the `bb.host` entry (src/host.ts), which keeps a
// Python worker with the model resident in memory. This file owns settings, the
// CLI, and the RPC the composer button calls.
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { parseParts } from "./src/model-parts";
import {
  ENGINES,
  HISTORY_AUDIO_ROUTE,
  PANEL_PATH,
  rpcContract,
  voiceHostContract,
  type AssetSpecConfig,
  type ConversationTiming,
  type EngineConfig,
  type EngineStatus,
  type QuickReplyResult,
  type SpeakResult,
  type SpokenClip,
  type TranscriptionResult,
} from "./contract.js";

export { rpcContract };
export type { EngineStatus, TranscriptionResult };

/** The AI service id: what `bb settings ai-services set voice` takes. */
const SERVICE_ID = "voice-ink";

/**
 * How long bb waits for one transcription before it gives up on it: bb 0.46
 * allows a voice service 70 seconds in a single attempt (AI_TASK_TIMEOUT_MS in
 * its server; the SDK comment's "10 seconds" is out of date). The host answers
 * with what it has just before that, so the composer never gets nothing.
 */
const VOICE_WAIT_MS = 70_000;

/** How long warming up may take: loading the model, not downloading it (that runs in the background). */
const WARMUP_WAIT_MS = 180_000;

/** `bb voice-ink transcribe`: the host's own limit for one file, plus the way back. */
const TRANSCRIBE_FILE_WAIT_MS = 610_000;

/** Where python/tts_server.py listens unless the settings say otherwise. */
const DEFAULT_SPEECH_SERVICE_URL = "http://127.0.0.1:38951";

/** One sentence never takes this long; past it the service is stuck, not busy. */
const SPEAK_TIMEOUT_MS = 30_000;

/** The quick voice is only worth it while it beats the agent by a wide margin. */
const QUICK_TIMEOUT_MS = 8_000;

/** Default fillers when the settings leave them empty. */
const ACK_RU = ["Угу.", "Так.", "Ага.", "Секунду.", "Понял."];
const WAIT_RU = ["Ещё секунду.", "Секунду, разбираюсь."];
const ACK_EN = ["Mm-hm.", "Okay.", "Right.", "One sec.", "Got it."];
const WAIT_EN = ["Just a moment.", "Still on it."];

/** Exchanges kept for `bb voice-ink latency`, newest last. */
const TIMING_KEY = "conversation-timings";
const TIMING_LIMIT = 200;

/** Cleanup backends the settings offer; the value is validated on the way out. */
const CLEANUP_PROVIDERS = ["off", "groq", "anthropic", "openai-compatible"] as const;
type CleanupProvider = (typeof CLEANUP_PROVIDERS)[number];

function parseCleanupProvider(value: string): CleanupProvider {
  return CLEANUP_PROVIDERS.find((candidate) => candidate === value) ?? "off";
}

/**
 * The whisper.cpp engine's defaults: the quantized large-v3-turbo model from
 * whisper.cpp's own model repository, and whisper.cpp's own Windows build.
 * Builds for macOS (Metal) and Linux come from this repository's workflow
 * (.github/workflows/voice-ink-whisper-cpp.yml) and are set per installation.
 */
const DEFAULT_WHISPER_CPP_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
const DEFAULT_WHISPER_CPP_MODEL_SHA256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
const DEFAULT_WHISPER_CPP_WINDOWS_URL =
  "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";
const DEFAULT_WHISPER_CPP_WINDOWS_SHA256 = "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb";

/** The onboarding answer for a build's setup page, shared with the other plugins of this repository. */
const setupStatusContract = defineRpcContract({
  setupStatus: {
    experimental_description:
      "Whether local speech recognition is set up on a machine: done, todo or problem, with one line for a person. Reads the saved state only.",
    input: z.object({ lang: z.enum(["en", "ru"]).optional(), hostId: z.string().min(1).max(200).optional() }).strict(),
    output: z
      .object({
        state: z.enum(["done", "todo", "problem"]),
        summary: z.string().max(200),
        path: z.string().regex(/^\/plugins\//).optional(),
      })
      .strict(),
  },
});

const SETUP_TEXT = {
  en: {
    done: "Voice input is ready on this machine",
    downloading: (percent: number | null) =>
      percent === null ? "Downloading the speech model" : `Downloading the speech model: ${percent}%`,
    notSelected: "The speech model is ready; pick Voice Ink for voice input in Settings, AI services",
    notReady: "Speech recognition is not ready yet; `bb voice-ink status` shows why",
    failed: "Speech recognition could not be set up; `bb voice-ink status` shows why",
    noMachine: "No machine is connected to bb",
  },
  ru: {
    done: "Голосовой ввод на этой машине готов",
    downloading: (percent: number | null) =>
      percent === null ? "Скачивается модель распознавания речи" : `Скачивается модель распознавания речи: ${percent}%`,
    notSelected: "Модель на месте; выберите Voice Ink для голосового ввода в настройках, AI services",
    notReady: "Распознавание речи ещё не готово; причину покажет `bb voice-ink status`",
    failed: "Распознавание речи не удалось настроить; причину покажет `bb voice-ink status`",
    noMachine: "К bb не подключена ни одна машина",
  },
} as const;

/** Models offered in settings, fastest first. Measurements are in the README. */
const MODEL_OPTIONS = ["small", "medium", "large-v3-turbo"] as const;

/** Model names faster-whisper resolves itself; anything else is a local path. */
const MODEL_REPOS: Record<string, string> = {
  "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
};

/**
 * Spend a core budget on recognition passes; threads per pass times passes
 * never exceeds it.
 *
 * Splitting a long recording pays off only once there are cores to spare.
 * Measured inside two cores: as two single-threaded passes a minute takes
 * 10.2s and a short phrase 6.7s, while one two-threaded pass takes 10.6s and
 * 4.7s. Short phrases are what dictation is mostly made of, so below four
 * cores the budget goes into one pass.
 */
function splitCores(cores: number): { threads: number; parallel: number } {
  const budget = Math.max(1, cores);
  const parallel = Math.min(3, Math.max(1, Math.floor(budget / 2)));
  return { threads: Math.max(1, Math.floor(budget / parallel)), parallel };
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloat(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    // whisper.cpp needs nothing installed: the plugin downloads the program and
    // the model from the addresses below and checks their SHA-256.
    engine: {
      type: "select",
      label: "Recognition engine",
      options: [...ENGINES],
      default: "faster-whisper",
    },
    model: {
      type: "select",
      label: "Model (faster-whisper)",
      options: [...MODEL_OPTIONS],
      default: "medium",
    },
    whisperCppModelUrl: {
      type: "string",
      label: "whisper.cpp model address (a ggml .bin file)",
      default: DEFAULT_WHISPER_CPP_MODEL_URL,
    },
    whisperCppModelSha256: {
      type: "string",
      label: "whisper.cpp model SHA-256 (of the whole file, also when it comes in parts)",
      default: DEFAULT_WHISPER_CPP_MODEL_SHA256,
    },
    whisperCppModelParts: {
      type: "string",
      label: "whisper.cpp model in parts, in order: one part per line, its address and its SHA-256 (used instead of the single address when set)",
      experimental_multiline: true,
      default: "",
    },
    whisperCppMacArm64Url: {
      type: "string",
      label: "whisper.cpp program for macOS on Apple silicon (zip address)",
      default: "",
    },
    whisperCppMacArm64Sha256: { type: "string", label: "SHA-256 of the macOS zip", default: "" },
    whisperCppWindowsX64Url: {
      type: "string",
      label: "whisper.cpp program for Windows x64 (zip address)",
      default: DEFAULT_WHISPER_CPP_WINDOWS_URL,
    },
    whisperCppWindowsX64Sha256: {
      type: "string",
      label: "SHA-256 of the Windows zip",
      default: DEFAULT_WHISPER_CPP_WINDOWS_SHA256,
    },
    whisperCppLinuxX64Url: {
      type: "string",
      label: "whisper.cpp program for Linux x64 (zip address)",
      default: "",
    },
    whisperCppLinuxX64Sha256: { type: "string", label: "SHA-256 of the Linux zip", default: "" },
    downloadHeader: {
      type: "string",
      label: "Header sent with the downloads, if the server needs one (Name: value)",
      secret: true,
    },
    // Off keeps every word on this machine: no transcript cleanup by an online
    // model and no quick voice, whatever the settings below say.
    onlineServices: {
      type: "boolean",
      label: "Allow features that send text to online services (transcript cleanup, quick voice)",
      default: true,
    },
    language: {
      type: "select",
      label: "Spoken language",
      options: ["auto", "ru", "en"],
      default: "auto",
    },
    vocabulary: {
      type: "string",
      label: "Vocabulary hints",
      experimental_multiline: true,
      default: "",
    },
    computeType: {
      type: "select",
      label: "Precision",
      options: ["int8", "int8_float32", "float32"],
      default: "int8",
    },
    // Whisper shares this machine with bb, the agents and everything else, so
    // the user caps it in the unit they actually care about: cores.
    cpuCores: {
      type: "string",
      label: "CPU cores recognition may use",
      default: "2",
    },
    // Batching shaves about a tenth off long audio but hands the model
    // VAD-split chunks whose opening words the smaller models drop, so it is
    // off unless someone deliberately turns it on.
    batchSize: { type: "string", label: "Batch size", default: "1" },
    pythonPath: { type: "string", label: "Python interpreter", default: "" },
    idleMinutes: {
      type: "string",
      label: "Unload the model after N idle minutes (0 = keep it loaded)",
      default: "0",
    },
    punctuation: {
      type: "boolean",
      label: "Restore punctuation and sentence boundaries (runs on this machine)",
      default: true,
    },
    paragraphPause: {
      type: "string",
      label: "Start a new paragraph after a pause of N seconds",
      default: "1.2",
    },
    // The local pass fixes punctuation but not misheard words. A language model
    // does both — at the cost of a key and of the transcript (never the audio)
    // leaving this machine.
    cleanup: {
      type: "select",
      label: "Clean the transcript up with a language model",
      options: [...CLEANUP_PROVIDERS],
      default: "off",
    },
    cleanupApiKey: { type: "string", label: "Cleanup API key", secret: true },
    cleanupModel: {
      type: "string",
      label: "Cleanup model",
      default: "llama-3.3-70b-versatile",
    },
    cleanupBaseUrl: {
      type: "string",
      label: "Cleanup endpoint (openai-compatible only)",
      default: "",
    },
    cleanupInstruction: {
      type: "string",
      label: "Extra cleanup instruction",
      experimental_multiline: true,
      default: "",
    },
    composerButton: {
      type: "boolean",
      label: "Show this plugin's own microphone button",
      default: false,
    },
    // bb waits seventy seconds for a transcription; a long dictation on a
    // slow model takes longer, so what it does not wait for has to be kept
    // somewhere the user can still reach it.
    history: {
      type: "boolean",
      label: "Keep a history of dictations (audio and transcript)",
      default: true,
    },
    historyLimit: {
      type: "string",
      label: "Keep at most N dictations (0 = no limit)",
      default: "200",
    },
    historyDays: {
      type: "string",
      label: "Delete dictations older than N days (0 = keep them)",
      default: "30",
    },
    // Conversation mode: talk, the phrase is sent on a pause, the reply is
    // read aloud sentence by sentence, and listening resumes.
    conversationButton: {
      type: "boolean",
      label: "Show the conversation button (talk and hear replies)",
      default: true,
    },
    speechServiceUrl: {
      type: "string",
      label: "Speech service URL (python/tts_server.py)",
      default: DEFAULT_SPEECH_SERVICE_URL,
    },
    endOfSpeechMs: {
      type: "string",
      label: "Pause that ends your phrase, in milliseconds",
      default: "900",
    },
    bargeIn: {
      type: "boolean",
      label: "Stop reading when you start talking",
      default: true,
    },
    conversationMarker: {
      type: "string",
      label: "Tag appended to spoken messages, so the agent answers briefly",
      default: "(voice)",
    },
    // The agent takes seconds to start answering in a long thread. A small
    // model fills that silence with one sentence; the agent's answer follows.
    quickVoice: {
      type: "boolean",
      label: "Quick voice: a small model says one sentence while the agent thinks",
      default: true,
    },
    quickModel: { type: "string", label: "Quick voice model", default: "claude-sonnet-5-5" },
    claudePath: { type: "string", label: "Claude Code binary for the quick voice", default: "" },
    fillers: {
      type: "string",
      label: "Instant acknowledgements, one per line (empty = by spoken language)",
      experimental_multiline: true,
      default: "",
    },
    waitFillers: {
      type: "string",
      label: "Said once when a reply keeps you waiting, one per line (empty = by language)",
      experimental_multiline: true,
      default: "",
    },
  });

  async function currentConfig(): Promise<EngineConfig> {
    const values = await settings.get();
    const model = values.model;
    const spec = (url: string, sha256: string): AssetSpecConfig => ({
      url: url.trim(),
      sha256: sha256.trim().toLowerCase(),
    });
    const engine = values.engine === "whisper.cpp" ? "whisper.cpp" : "faster-whisper";
    return {
      engine,
      whisperCpp:
        engine === "whisper.cpp"
          ? {
              model: {
                ...spec(values.whisperCppModelUrl, values.whisperCppModelSha256),
                parts: parseParts(values.whisperCppModelParts ?? ""),
              },
              runtimes: {
                "darwin-arm64": spec(values.whisperCppMacArm64Url, values.whisperCppMacArm64Sha256),
                "win32-x64": spec(values.whisperCppWindowsX64Url, values.whisperCppWindowsX64Sha256),
                "linux-x64": spec(values.whisperCppLinuxX64Url, values.whisperCppLinuxX64Sha256),
              },
              authHeader: values.downloadHeader?.trim() ? values.downloadHeader.trim() : null,
            }
          : null,
      offline: !values.onlineServices,
      model: MODEL_REPOS[model] ?? model,
      computeType: values.computeType,
      ...splitCores(parsePositiveInt(values.cpuCores, 2)),
      batchSize: parsePositiveInt(values.batchSize, 4),
      language: values.language === "auto" ? null : values.language,
      vocabulary: values.vocabulary.trim() === "" ? null : values.vocabulary.trim(),
      pythonPath: values.pythonPath.trim() === "" ? null : values.pythonPath.trim(),
      // Loading a model takes longer than bb's ten-second budget for one
      // transcription attempt, so by default it is never unloaded: the first
      // phrase after a quiet hour must not be the one that fails.
      idleUnloadMs: parseNonNegativeInt(values.idleMinutes, 0) * 60_000,
      history: {
        enabled: values.history,
        maxEntries: parseNonNegativeInt(values.historyLimit, 200),
        maxAgeDays: parseNonNegativeInt(values.historyDays, 30),
      },
      punctuate: values.punctuation,
      paragraphPauseSec: parsePositiveFloat(values.paragraphPause, 1.2),
      polish: {
        provider: values.onlineServices ? parseCleanupProvider(values.cleanup) : "off",
        apiKey: values.cleanupApiKey?.trim() === "" ? null : (values.cleanupApiKey ?? null),
        model: values.cleanupModel.trim(),
        baseUrl: values.cleanupBaseUrl.trim() === "" ? null : values.cleanupBaseUrl.trim(),
        extraInstruction:
          values.cleanupInstruction.trim() === "" ? null : values.cleanupInstruction.trim(),
      },
    };
  }

  const host = bb.hosts.experimental_client({ contract: voiceHostContract });

  /** The machine the recognition worker runs on: bb's connected host. */
  async function hostId(): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((candidate) => candidate.status === "connected");
    if (connected === undefined) {
      throw new Error("no connected machine to run speech recognition on");
    }
    return connected.id;
  }

  async function applyConfig(warmUp: boolean): Promise<EngineStatus> {
    const id = await hostId();
    const config = await currentConfig();
    const status = await host.call("voice.configure", { config }, { hostId: id });
    if (!warmUp) return status;
    // Loading a large model on a slow CPU, or Metal compiling its kernels on
    // the first start, outlasts the 30 seconds a host call gets by default.
    return host.call("voice.status", { warmUp: true }, { hostId: id, timeoutMs: WARMUP_WAIT_MS });
  }

  bb.experimental_aiServices.register({
    id: SERVICE_ID,
    displayName: "Voice Ink (local Whisper)",
    // bb's own microphone button. The host answers with whatever is recognized
    // before bb stops waiting and keeps the whole text in history.
    transcribe: async (audio, { signal, hint }) => {
      const started = Date.now();
      const id = await hostId();
      const audioBase64 = Buffer.from(await audio.arrayBuffer()).toString("base64");
      // A second of the wait is left for the way back to bb.
      const budget = Math.max(1_000, VOICE_WAIT_MS - 1_000 - (Date.now() - started));
      const result = await host.call(
        "voice.transcribeRecording",
        {
          audioBase64,
          mimeType: audio.type === "" ? "application/octet-stream" : audio.type,
          prompt: hint,
          timeoutMs: budget,
        },
        // A host call fails after 30 seconds unless told otherwise, which a long
        // dictation outlasts; the host itself answers within `budget`.
        { hostId: id, signal, timeoutMs: budget + 5_000 },
      );
      if (!result.ok) throw new Error(result.message);
      return result.text;
    },
    // Without a machine there is nothing to run the model on; bb then hides the
    // microphone instead of offering a button that can only fail. With
    // whisper.cpp, so is a program or model that is not downloaded yet; the
    // poll itself starts a download that is missing or due for another try.
    // faster-whisper has nothing to download first: its button stays.
    status: async () => {
      try {
        const id = await hostId();
        if ((await settings.get()).engine !== "whisper.cpp") return { ready: true };
        const status = await host.call(
          "voice.status",
          { warmUp: false, ensureFiles: true },
          { hostId: id, timeoutMs: 5_000 },
        );
        if (!status.assetsReady) {
          return { ready: false, message: status.message ?? "the speech model is not downloaded yet" };
        }
        return { ready: true };
      } catch (error) {
        return { ready: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  type RpcHandlers = Parameters<typeof bb.rpc.register<typeof rpcContract>>[1];
  type Handler = (input: unknown, context: Parameters<RpcHandlers["status"]>[1]) => unknown;
  /** Recordings, history and the speech service are for this plugin's own panel, not for other plugins. */
  const ownCallers = (handlers: RpcHandlers): RpcHandlers =>
    Object.fromEntries(
      Object.entries(handlers as Record<string, Handler>).map(([name, handler]) => [
        name,
        ((input, context) => {
          if (context.experimental_caller.kind !== "client") {
            throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Voice Ink does not answer other plugins." });
          }
          return handler(input, context);
        }) satisfies Handler,
      ]),
    ) as unknown as RpcHandlers;

  bb.rpc.register(rpcContract, ownCallers({
    status: async ({ warmUp }) => {
      const id = await hostId();
      await host.call("voice.configure", { config: await currentConfig() }, { hostId: id });
      return host.call("voice.status", { warmUp }, { hostId: id });
    },
    transcribe_segment: async (input) => {
      const id = await hostId();
      return host.call("voice.transcribeSegment", input, { hostId: id });
    },
    history_list: async (input) => {
      const id = await hostId();
      return host.call("voice.history.list", input, { hostId: id });
    },
    history_delete: async (input) => {
      const id = await hostId();
      return host.call("voice.history.delete", input, { hostId: id });
    },
    history_clear: async () => {
      const id = await hostId();
      return host.call("voice.history.clear", {}, { hostId: id });
    },
    speak: async ({ text }) => speak(text),
    conversation_config: async () => {
      const values = await settings.get();
      const quickVoice = values.quickVoice && values.onlineServices;
      if (quickVoice) {
        // The resident model starts loading now, while the user says the first phrase.
        void hostId()
          .then((id) =>
            host.call("voice.quick.warm", quickTarget(values), { hostId: id }),
          )
          .catch((error: unknown) => bb.log.warn(`quick voice did not start: ${String(error)}`));
      }
      return {
        endOfSpeechMs: parsePositiveInt(values.endOfSpeechMs, 900),
        bargeIn: values.bargeIn,
        marker: values.conversationMarker.trim(),
        quickVoice,
      };
    },
    quick_reply: async ({ text, recent }): Promise<QuickReplyResult> => {
      const values = await settings.get();
      if (!values.quickVoice || !values.onlineServices) {
        return { ok: false, code: "off", message: "quick voice is off" };
      }
      const started = Date.now();
      const history = recent
        .map((line) => `${line.who === "user" ? "User" : "Agent"}: ${line.text}`)
        .join("\n");
      const prompt = [
        history === "" ? "" : `Recent conversation, oldest first:\n${history}\n`,
        `The user just said: «${text}»`,
      ]
        .filter(Boolean)
        .join("\n");
      const answer = await host.call(
        "voice.quick",
        { prompt, ...quickTarget(values), timeoutMs: QUICK_TIMEOUT_MS },
        { hostId: await hostId(), timeoutMs: QUICK_TIMEOUT_MS + 2_000 },
      );
      if (!answer.ok) return { ok: false, code: answer.code, message: answer.message };
      const spoken = await speak(answer.text);
      if (!spoken.ok) return { ok: false, code: spoken.code, message: spoken.message };
      return {
        ok: true,
        text: answer.text,
        quickMs: Date.now() - started,
        clip: { text: answer.text, audioBase64: spoken.audioBase64, mimeType: spoken.mimeType },
      };
    },
    fillers: async () => {
      const values = await settings.get();
      const russian = values.language !== "en";
      const lines = (value: string, fallback: readonly string[]) => {
        const listed = value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return listed.length > 0 ? listed : [...fallback];
      };
      const ack = lines(values.fillers, russian ? ACK_RU : ACK_EN);
      const wait = lines(values.waitFillers, russian ? WAIT_RU : WAIT_EN);
      return { ack: await clips(ack), wait: await clips(wait) };
    },
    conversation_log: async ({ entry }) => {
      const kept = (await bb.storage.kv.get<ConversationTiming[]>(TIMING_KEY)) ?? [];
      kept.push(entry);
      await bb.storage.kv.set(TIMING_KEY, kept.slice(-TIMING_LIMIT));
      return { ok: true as const };
    },
  }));

  // The one method other plugins may call: a build's setup page asks whether
  // voice input works here. It reads the host's state; no download, no address.
  bb.rpc.register(
    setupStatusContract,
    {
      setupStatus: async ({ lang = "en", hostId: requested }) => {
        const text = SETUP_TEXT[lang];
        const path = `/plugins/${bb.pluginId}/${PANEL_PATH}`;
        let machine: string;
        try {
          machine = requested ?? (await hostId());
        } catch {
          return { state: "problem" as const, summary: text.noMachine };
        }
        let status: EngineStatus;
        try {
          status = await host.call("voice.status", { warmUp: false }, { hostId: machine, timeoutMs: 4_000 });
        } catch {
          return { state: "problem" as const, summary: text.notReady, path };
        }
        if (status.download !== null) {
          const { doneBytes, totalBytes } = status.download;
          const percent = totalBytes !== null && totalBytes > 0 ? Math.min(100, Math.floor((doneBytes / totalBytes) * 100)) : null;
          return { state: "todo" as const, summary: text.downloading(percent), path };
        }
        if (!status.assetsReady) {
          return status.state === "failed"
            ? { state: "problem" as const, summary: text.failed, path }
            : { state: "todo" as const, summary: text.notReady, path };
        }
        const services = await bb.sdk.system.aiServices().catch(() => null);
        const voice = services?.selections.voice;
        const selected = voice?.mode === "service" && voice.pluginId === bb.pluginId && voice.serviceId === SERVICE_ID;
        if (!selected) return { state: "todo" as const, summary: text.notSelected, path };
        return { state: "done" as const, summary: text.done, path };
      },
    },
    { experimental_discoverable: true, experimental_description: "Voice Ink setup state for a bb build's onboarding page." },
  );

  function quickTarget(values: { quickModel: string; claudePath: string }) {
    return {
      model: values.quickModel.trim() || "claude-sonnet-5-5",
      claudePath: values.claudePath.trim() === "" ? null : values.claudePath.trim(),
    };
  }

  /** Fillers are the same few phrases every time: synthesized once, kept in memory. */
  const clipCache = new Map<string, SpokenClip>();
  async function clips(texts: readonly string[]): Promise<SpokenClip[]> {
    const out: SpokenClip[] = [];
    for (const text of texts) {
      let clip = clipCache.get(text);
      if (clip === undefined) {
        const spoken = await speak(text);
        if (!spoken.ok) continue;
        clip = { text, audioBase64: spoken.audioBase64, mimeType: spoken.mimeType };
        clipCache.set(text, clip);
      }
      out.push(clip);
    }
    return out;
  }

  /**
   * The speech service runs next to bb on this machine, outside bb's own
   * process: the model holds about two gigabytes and takes two minutes to load,
   * which is not something to restart with the plugin.
   */
  async function speak(text: string): Promise<SpeakResult> {
    const values = await settings.get();
    const base = values.speechServiceUrl.trim() || DEFAULT_SPEECH_SERVICE_URL;
    // The text of agent replies goes to this service: with online features
    // off, only to one on this machine.
    if (!values.onlineServices && !isLoopbackUrl(base)) {
      return {
        ok: false,
        code: "unreachable",
        message: `the speech service at ${base} is not on this machine, and online features are off`,
      };
    }
    let response: Response;
    try {
      response = await fetch(new URL("/synth", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        code: "unreachable",
        message: `speech service at ${base} did not answer: ${String(error)}`,
      };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const code =
        response.status === 400 ? "empty" : response.status === 503 ? "loading" : "failed";
      return { ok: false, code, message: body.slice(0, 300) || `HTTP ${response.status}` };
    }
    const header = (name: string) => {
      const value = Number(response.headers.get(name));
      return Number.isFinite(value) && response.headers.has(name) ? value : null;
    };
    const spoken = response.headers.get("x-spoken-text");
    return {
      ok: true,
      audioBase64: Buffer.from(await response.arrayBuffer()).toString("base64"),
      mimeType: response.headers.get("content-type") ?? "audio/mpeg",
      synthMs: header("x-synth-ms"),
      audioMs: header("x-audio-ms"),
      spokenText: spoken === null ? null : decodeURIComponent(spoken),
    };
  }

  // The panel plays audio through an <audio> element, which needs bytes at a
  // URL rather than a base64 string in an RPC reply.
  bb.http.route("GET", HISTORY_AUDIO_ROUTE, async (context) => {
    const id = context.req.query("id");
    if (typeof id !== "string" || id.trim() === "") {
      return new Response(JSON.stringify({ error: "invalid_params" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const found = await host.call("voice.history.audio", { id }, { hostId: await hostId() });
    if (found === null) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const bytes = Buffer.from(found.audioBase64, "base64");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": found.mimeType,
        "content-length": String(bytes.byteLength),
        // Recordings never change once written, so the panel may keep them.
        "cache-control": "private, max-age=86400, immutable",
      },
    });
  });

  // Settings are applied to the host, not read there: a model change retires the
  // resident worker so the next phrase runs on what the user just chose.
  settings.onChange(() => {
    // Warm up as well as reconfigure: a model change retires the worker, and
    // loading the new one takes longer than bb allows for one transcription.
    void applyConfig(true).catch((error: unknown) => {
      bb.log.warn(`could not apply settings to the recognition host: ${String(error)}`);
    });
  });

  // The host worker starts on demand, but the first phrase should not pay for
  // loading the model, so the configuration is pushed as soon as bb is up.
  bb.background.service("configure", {
    async start(signal) {
      try {
        const status = await applyConfig(true);
        bb.log.info(`recognition configured: ${status.state}, model ${status.model ?? "-"}`);
      } catch (error) {
        if (!signal.aborted) {
          bb.log.warn(`could not configure recognition host: ${String(error)}`);
        }
      }
    },
  });

  const usage = [
    "Usage:",
    "  bb voice-ink status [--json]        Show the recognition engine's state",
    "  bb voice-ink warmup [--json]        Load the model now so the first phrase is fast",
    "  bb voice-ink transcribe <file>      Transcribe an audio file with the local model",
    "  bb voice-ink last [--json]          Show the last transcript, even if the caller gave up",
    "  bb voice-ink history [--json] [-n N] List past dictations",
    "  bb voice-ink show <id> [--json]     Show one dictation in full",
    "  bb voice-ink forget <id>|--all      Delete a dictation, or all of them",
    "  bb voice-ink enable                 Point bb's microphone at this plugin",
    "  bb voice-ink say <text> [-o file]   Speak a phrase through the speech service",
    "  bb voice-ink latency [--json] [-n N] Timings of recent conversation exchanges",
  ].join("\n");

  bb.cli.register({
    name: "voice-ink",
    summary: "Local speech recognition for the chat composer",
    commands: [
      { name: "status", summary: "Show engine state", usage: "bb voice-ink status [--json]" },
      { name: "warmup", summary: "Load the model now", usage: "bb voice-ink warmup [--json]" },
      {
        name: "transcribe",
        summary: "Transcribe an audio file",
        usage: "bb voice-ink transcribe <file> [--json]",
      },
      {
        name: "last",
        summary: "Show the last transcript this machine produced",
        usage: "bb voice-ink last [--json]",
      },
      {
        name: "history",
        summary: "List past dictations",
        usage: "bb voice-ink history [--json] [-n N]",
      },
      {
        name: "show",
        summary: "Show one dictation in full",
        usage: "bb voice-ink show <id> [--json]",
      },
      {
        name: "forget",
        summary: "Delete a dictation, or all of them",
        usage: "bb voice-ink forget <id>|--all",
      },
      {
        name: "enable",
        summary: "Point bb's microphone at this plugin",
        usage: "bb voice-ink enable",
      },
      {
        name: "say",
        summary: "Speak a phrase through the speech service",
        usage: "bb voice-ink say <text> [-o file.mp3] [--json]",
      },
      {
        name: "latency",
        summary: "Timings of recent conversation exchanges",
        usage: "bb voice-ink latency [--json] [-n N]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "status":
        case "warmup": {
          const status = await applyConfig(command === "warmup");
          const lines = [`engine: ${status.engine}`, `state:  ${status.state}`, `model:  ${status.model ?? "-"}`];
          if (status.engine === "whisper.cpp") {
            lines.push(`files:  ${status.assetsReady ? "downloaded and checked" : "not downloaded yet"}`);
            if (status.runtimePath !== null) lines.push(`server: ${status.runtimePath}`);
          } else {
            lines.push(`python: ${status.pythonPath ?? "not resolved yet"}`);
          }
          if (status.message !== null) lines.push(`note:   ${status.message}`);
          return reply(status, lines.join("\n"));
        }

        case "transcribe": {
          const file = args[0];
          if (file === undefined) break;
          const audio = await readFile(file);
          const id = await hostId();
          const started = Date.now();
          const result = await host.call(
            "voice.transcribeSegment",
            {
              audioBase64: audio.toString("base64"),
              mimeType: `audio/${basename(file).split(".").pop() ?? "wav"}`,
              language: null,
            },
            // The host gives a file up to ten minutes; the call waits that long too.
            { hostId: id, timeoutMs: TRANSCRIBE_FILE_WAIT_MS },
          );
          if (!result.ok) {
            return { exitCode: 1, stderr: `${result.code}: ${result.message}` };
          }
          const wall = ((Date.now() - started) / 1000).toFixed(1);
          return reply(
            result,
            `${result.text}\n\n(${result.audioSec}s of audio in ${result.elapsedSec}s, ${wall}s wall)`,
          );
        }

        case "last": {
          const id = await hostId();
          const { text } = await host.call("voice.last", {}, { hostId: id });
          if (text === null) {
            return { exitCode: 1, stderr: "Nothing has been transcribed yet." };
          }
          return reply({ text }, text);
        }

        case "history": {
          const index = args.findIndex((arg) => arg === "-n" || arg === "--limit");
          const limit = index === -1 ? 20 : parsePositiveInt(args[index + 1] ?? "", 20);
          const queryArgs = args.filter(
            (arg, position) => position !== index && position !== index + 1,
          );
          const id = await hostId();
          const listed = await host.call(
            "voice.history.list",
            { query: queryArgs.join(" "), limit: Math.min(limit, 200), offset: 0 },
            { hostId: id },
          );
          if (listed.entries.length === 0) {
            return reply(listed, "No dictations recorded yet.");
          }
          const lines = listed.entries.map((entry) => {
            const when = new Date(entry.createdAt).toLocaleString();
            const seconds = entry.durationSec === null ? "" : ` ${entry.durationSec.toFixed(0)}s`;
            const cut =
              entry.deliveredChars !== null && entry.deliveredChars < entry.text.length
                ? " [partially delivered]"
                : "";
            const preview = entry.text.replace(/\s+/g, " ").slice(0, 80);
            return `${entry.id.slice(0, 8)}  ${when}${seconds}${cut}  ${preview}`;
          });
          return reply(listed, [...lines, "", `${listed.total} in total`].join("\n"));
        }

        case "show": {
          const wanted = args[0];
          if (wanted === undefined) break;
          const id = await hostId();
          // Ids are long; the list prints a short prefix, so accept one here.
          const listed = await host.call(
            "voice.history.list",
            { query: "", limit: 200, offset: 0 },
            { hostId: id },
          );
          const entry = listed.entries.find((candidate) => candidate.id.startsWith(wanted));
          if (entry === undefined) {
            return { exitCode: 1, stderr: `No dictation starts with "${wanted}".` };
          }
          return reply(entry, entry.text);
        }

        case "forget": {
          const id = await hostId();
          if (args.includes("--all")) {
            const { removed } = await host.call("voice.history.clear", {}, { hostId: id });
            return reply({ removed }, `Deleted ${removed} dictation(s).`);
          }
          const wanted = args[0];
          if (wanted === undefined) break;
          const listed = await host.call(
            "voice.history.list",
            { query: "", limit: 200, offset: 0 },
            { hostId: id },
          );
          const entry = listed.entries.find((candidate) => candidate.id.startsWith(wanted));
          if (entry === undefined) {
            return { exitCode: 1, stderr: `No dictation starts with "${wanted}".` };
          }
          const { removed } = await host.call(
            "voice.history.delete",
            { id: entry.id },
            { hostId: id },
          );
          return reply({ removed }, removed ? "Deleted." : "Nothing to delete.");
        }

        case "enable": {
          const { selections } = await bb.sdk.system.setAiServiceSelection({
            task: "voice",
            selection: { mode: "service", pluginId: bb.pluginId, serviceId: SERVICE_ID },
          });
          return reply(
            selections.voice,
            [
              "bb's microphone now goes to Voice Ink.",
              "Back to bb's own choice: bb settings ai-services set voice automatic",
            ].join("\n"),
          );
        }

        case "say": {
          const out = args.indexOf("-o");
          const file = out === -1 ? null : (args[out + 1] ?? null);
          const words = args.filter((_, index) => out === -1 || (index !== out && index !== out + 1));
          const text = words.join(" ").trim();
          if (text === "") break;
          const started = Date.now();
          const result = await speak(text);
          if (!result.ok) return { exitCode: 1, stderr: `${result.code}: ${result.message}` };
          if (file !== null) await writeFile(file, Buffer.from(result.audioBase64, "base64"));
          const { audioBase64: _audio, ...meta } = result;
          return reply(
            { ...meta, wallMs: Date.now() - started, file },
            [
              `spoken: ${result.spokenText ?? text}`,
              `audio ${result.audioMs ?? "?"} ms, synthesized in ${result.synthMs ?? "?"} ms, ` +
                `${Date.now() - started} ms end to end`,
              file === null ? "" : `saved to ${file}`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }

        case "latency": {
          const limitAt = args.indexOf("-n");
          const limit = limitAt === -1 ? 20 : parsePositiveInt(args[limitAt + 1] ?? "", 20);
          const kept = ((await bb.storage.kv.get<ConversationTiming[]>(TIMING_KEY)) ?? []).slice(
            -limit,
          );
          if (kept.length === 0) {
            return { exitCode: 1, stderr: "No conversation exchanges recorded yet." };
          }
          return reply(kept, formatTimings(kept));
        }
      }

      return { exitCode: 1, stderr: usage };
    },
  });
}

/** Seconds with one decimal, or a dash for a step that did not happen. */
function seconds(ms: number | null): string {
  return ms === null ? "-" : (ms / 1000).toFixed(1);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * One row per exchange, all times in seconds from the end of the user's
 * phrase, then the medians. "quick" is when the quick voice was heard and
 * "voice" when the agent's own reply started.
 */
function formatTimings(entries: readonly ConversationTiming[]): string {
  const header =
    "time      words  ack    text   sent   quick  reply  1st    audio  voice  done   synth";
  const rows = entries.map((entry) =>
    [
      new Date(entry.at).toTimeString().slice(0, 8),
      String(entry.words).padStart(5),
      seconds(entry.ackMs).padStart(6),
      seconds(entry.transcribedMs).padStart(6),
      seconds(entry.submittedMs).padStart(6),
      seconds(entry.quickPlayingMs).padStart(6),
      seconds(entry.firstTextMs).padStart(6),
      seconds(entry.firstSentenceMs).padStart(6),
      seconds(entry.firstAudioMs).padStart(6),
      seconds(entry.playingMs).padStart(6),
      seconds(entry.turnDoneMs).padStart(6),
      seconds(entry.firstSynthMs).padStart(6),
      entry.interrupted ? " interrupted" : "",
    ].join(" "),
  );
  const pick = (key: keyof ConversationTiming) =>
    median(
      entries
        .map((entry) => entry[key])
        .filter((value): value is number => typeof value === "number"),
    );
  const summary = [
    `median, s: text ${seconds(pick("transcribedMs"))}, sent ${seconds(pick("submittedMs"))}, ` +
      `quick voice ${seconds(pick("quickPlayingMs"))}, reply ${seconds(pick("firstTextMs"))}, ` +
      `first sentence ${seconds(pick("firstSentenceMs"))}, voice ${seconds(pick("playingMs"))}`,
  ];
  return [header, ...rows, "", ...summary].join("\n");
}

