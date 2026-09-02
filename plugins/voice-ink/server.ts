// voice-ink — local speech recognition for bb's chat composer.
//
// bb routes voice transcription to whichever plugin registers an AI service of
// kind "voice" and is named by BB_TRANSCRIPTION. This plugin registers one and
// answers it from a Whisper model running on the machine bb runs on: no
// account, no API key, no audio leaving the box.
//
// The heavy lifting happens in the `bb.host` entry (src/host.ts), which keeps a
// Python worker with the model resident in memory. This file owns settings, the
// CLI, and the RPC the composer button calls.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  rpcContract,
  voiceHostContract,
  type EngineConfig,
  type EngineStatus,
  type TranscriptionResult,
} from "./contract.js";

export { rpcContract };
export type { EngineStatus, TranscriptionResult };

/** Must match VOICE_INK_SERVICE_ID in src/host.ts: it is the BB_TRANSCRIPTION prefix. */
const SERVICE_ID = "voice-ink";

/** Models offered in settings, fastest first. Measurements are in the README. */
const MODEL_OPTIONS = ["small", "medium", "large-v3-turbo"] as const;

/** Model names faster-whisper resolves itself; anything else is a local path. */
const MODEL_REPOS: Record<string, string> = {
  "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
};

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    model: {
      type: "select",
      label: "Model",
      options: [...MODEL_OPTIONS],
      default: "medium",
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
    threads: { type: "string", label: "CPU threads", default: "4" },
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
    composerButton: {
      type: "boolean",
      label: "Show this plugin's own microphone button",
      default: false,
    },
  });

  async function currentConfig(): Promise<EngineConfig> {
    const values = await settings.get();
    const model = values.model;
    return {
      model: MODEL_REPOS[model] ?? model,
      computeType: values.computeType,
      threads: parsePositiveInt(values.threads, 4),
      batchSize: parsePositiveInt(values.batchSize, 4),
      language: values.language === "auto" ? null : values.language,
      vocabulary: values.vocabulary.trim() === "" ? null : values.vocabulary.trim(),
      pythonPath: values.pythonPath.trim() === "" ? null : values.pythonPath.trim(),
      // Loading a model takes longer than bb's ten-second budget for one
      // transcription attempt, so by default it is never unloaded: the first
      // phrase after a quiet hour must not be the one that fails.
      idleUnloadMs: parseNonNegativeInt(values.idleMinutes, 0) * 60_000,
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
    return host.call("voice.status", { warmUp: true }, { hostId: id });
  }

  bb.experimental_aiServices.register({
    id: SERVICE_ID,
    displayName: "Voice Ink (local Whisper)",
    kinds: ["voice"],
  });

  bb.rpc.register(rpcContract, {
    status: async ({ warmUp }) => {
      const id = await hostId();
      await host.call("voice.configure", { config: await currentConfig() }, { hostId: id });
      return host.call("voice.status", { warmUp }, { hostId: id });
    },
    transcribe_segment: async (input) => {
      const id = await hostId();
      return host.call("voice.transcribeSegment", input, { hostId: id });
    },
  });

  // Settings are applied to the host, not read there: a model change retires the
  // resident worker so the next phrase runs on what the user just chose.
  settings.onChange(() => {
    void applyConfig(false).catch((error: unknown) => {
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
    "  bb voice-ink enable                 Print how to make this bb's transcription service",
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
        name: "enable",
        summary: "Print the command that points bb's microphone at this plugin",
        usage: "bb voice-ink enable",
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
          const lines = [
            `state:  ${status.state}`,
            `model:  ${status.model ?? "-"}`,
            `python: ${status.pythonPath ?? "not resolved yet"}`,
          ];
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
            { hostId: id },
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

        case "enable":
          return reply(
            { service: SERVICE_ID },
            [
              "Point bb's built-in microphone at this plugin:",
              "",
              `  npx bb-app config set BB_TRANSCRIPTION ${SERVICE_ID}/local`,
              "",
              "The model comes from this plugin's settings; the part after the",
              "slash is only a label.",
            ].join("\n"),
          );
      }

      return { exitCode: 1, stderr: usage };
    },
  });
}
