// The whisper.cpp engine: no Python, nothing to install. The plugin downloads
// whisper.cpp's server program and a ggml model from the addresses in its
// settings, checks both against their SHA-256, and keeps the server running on
// 127.0.0.1 with the model loaded.
//
// Recordings are decoded here (src/audio.ts), cut at pauses into pieces of at
// most 28 seconds (src/chunks.ts), and sent to the server one piece at a time
// as 16 kHz WAV, so the text arrives piece by piece and a pause long enough
// starts a new paragraph.
//
// Recognition settings follow VoiceInk, whose whisper.cpp setup this mirrors:
// a short sentence in the spoken language as the initial prompt (it is what
// makes the model punctuate), temperature 0.2, greedy decoding.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import type { EngineConfig, EngineStatus, TranscriptionResult, WhisperCppConfig } from "../contract.js";
import { AssetStore, findFile, type AssetProgress, type AssetSpec } from "./assets.js";
import { AudioFormatError, decodeToMono16k, encodeWav16, SAMPLE_RATE } from "./audio.js";
import { hasSpeech, splitAtPauses } from "./chunks.js";
import { failure, JobBoard, type TranscribeArgs } from "./jobs.js";

interface WorkerLease {
  dispose(): Promise<void>;
}

export interface WhisperCppEngineOptions {
  /** Downloads live under `<dataDir>/whisper-cpp`. */
  dataDir: string;
  log(message: string, fields?: Record<string, unknown>): void;
  /** Keeps the host worker (and with it the server) alive while it is warm. */
  retainWorker(): WorkerLease;
}

/** Where the machine running this host finds its build of the server. */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

const SERVER_NAME = process.platform === "win32" ? "whisper-server.exe" : "whisper-server";
/** Loading a model takes seconds; Metal compiles its kernels on the first start. */
const READY_TIMEOUT_MS = 300_000;
/** One piece is at most 28 seconds of audio; a slow CPU still finishes it in this. */
const PIECE_TIMEOUT_MS = 10 * 60_000;
/** A download that failed for a reason worth retrying is tried again after this. */
const RETRY_AFTER_MS = 60_000;
/**
 * One that failed for good (a wrong sum, a missing file, no access) is still
 * tried again after this: someone may have fixed the server meanwhile, and a
 * failed download must not hide the microphone until bb restarts.
 */
const PERMANENT_RETRY_AFTER_MS = 10 * 60_000;
/** A server asked to stop gets this long before it is killed. */
const STOP_GRACE_MS = 5_000;
const OUTPUT_TAIL_LINES = 12;

/** VoiceInk's prompts: an everyday sentence with punctuation in the spoken language. */
const LANGUAGE_PROMPTS: Record<string, string> = {
  ru: "Здравствуйте, как ваши дела? Приятно познакомиться.",
  en: "Hello, how are you doing? Nice to meet you.",
};

/**
 * What Whisper writes over silence and noise, learned from subtitles. A piece
 * whose whole text is one of these is dropped.
 */
const HALLUCINATIONS = [
  /^субтитры (сделал|создавал|делал) dimatorzok\.?$/i,
  /^продолжение следует\.*$/i,
  /^редактор субтитров .{0,60}$/i,
  /^спасибо за просмотр[.!]*$/i,
  /^(thank you|thanks) for watching[.!]*$/i,
];

interface Assets {
  server: string;
  model: string;
}

interface Segment {
  /** As whisper.cpp gives it: a leading space starts a word, none continues the previous one. */
  text: string;
  start: number;
  end: number;
}

export class WhisperCppEngine {
  private config: EngineConfig | null = null;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private lease: WorkerLease | null = null;
  private starting: Promise<void> | null = null;
  private state: EngineStatus["state"] = "idle";
  private message: string | null = null;
  private serverPath: string | null = null;
  private outputTail: string[] = [];
  private readonly board = new JobBoard();
  private readonly models: AssetStore;
  private readonly runtimes: AssetStore;
  private assetsTask: Promise<Assets> | null = null;
  private progress: AssetProgress | null = null;
  private assetError: { message: string; at: number; permanent: boolean } | null = null;
  /** Pieces go to the server one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private active = 0;

  constructor(private readonly options: WhisperCppEngineOptions) {
    this.models = new AssetStore(join(options.dataDir, "whisper-cpp", "models"));
    this.runtimes = new AssetStore(join(options.dataDir, "whisper-cpp", "runtime"));
  }

  currentConfig(): EngineConfig | null {
    return this.config;
  }

  status(): EngineStatus {
    const settings = this.config?.whisperCpp ?? null;
    const model = settings === null ? null : modelName(settings.model);
    if (this.progress !== null && this.assetsTask !== null) {
      return {
        state: "loading",
        engine: "whisper.cpp",
        model,
        pythonPath: null,
        runtimePath: this.serverPath,
        assetsReady: false,
        download: { ...this.progress },
        message: describeProgress(this.progress),
      };
    }
    const failed = this.assetError !== null && this.state !== "ready";
    return {
      state: failed ? "failed" : this.state,
      engine: "whisper.cpp",
      model,
      pythonPath: null,
      runtimePath: this.serverPath,
      assetsReady: this.presentAssets() !== null,
      download: null,
      message: failed ? (this.assetError?.message ?? null) : this.message,
    };
  }

  /** Apply a configuration; a different model, program, language or core count restarts the server. */
  async configure(config: EngineConfig): Promise<EngineStatus> {
    const previous = this.config;
    this.config = config;
    const before = previous?.whisperCpp ?? null;
    const after = config.whisperCpp;
    const changed =
      previous !== null &&
      (before?.model.sha256 !== after?.model.sha256 ||
        runtimeFor(before)?.sha256 !== runtimeFor(after)?.sha256 ||
        before?.authHeader !== after?.authHeader ||
        previous.threads * previous.parallel !== config.threads * config.parallel ||
        previous.language !== config.language);
    if (changed || JSON.stringify(before?.model) !== JSON.stringify(after?.model) || runtimeFor(before)?.url !== runtimeFor(after)?.url) {
      // A new address is worth trying at once, whatever failed before.
      this.assetError = null;
      this.clearRetry();
    }
    if (changed) await this.stop("configuration changed");
    return this.status();
  }

  /**
   * bb's readiness poll: files that are missing start downloading, unless a
   * download is running or failed too recently. A fresh worker (the daemon
   * restarts them) thus fetches its files without waiting for a dictation.
   */
  ensureFiles(): EngineStatus {
    const config = this.config;
    if (config !== null && this.presentAssets() === null) this.startDownload(config, false);
    return this.status();
  }

  /**
   * Make the engine ready: downloads start in the background (they take
   * minutes), and a server whose files are here is started and waited for.
   */
  async warmUp(): Promise<EngineStatus> {
    const config = this.config;
    if (config === null) return this.status();
    if (this.presentAssets() === null) {
      this.assetError = null;
      this.startDownload(config, true);
      return this.status();
    }
    try {
      await this.ensureStarted(config);
    } catch (error) {
      this.state = "failed";
      this.message = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }

  lastTranscript(): string | null {
    return this.board.lastTranscript();
  }

  async transcribe(args: TranscribeArgs): Promise<TranscriptionResult> {
    const config = this.config;
    if (config === null) return failure("service_unavailable", "voice-ink is not configured yet");
    if (args.audioBase64.length === 0) return failure("request_failed", "audio is empty");
    if (this.presentAssets() === null) {
      // A download takes minutes; nobody waits for it in a dictation.
      this.startDownload(config, false);
      const status = this.status();
      return failure("service_unavailable", status.message ?? "the speech model is not downloaded yet");
    }
    return this.board.transcribe(args, config.language, (onPartial) => this.run(args, config, onPartial));
  }

  async dispose(): Promise<void> {
    this.clearRetry();
    await this.stop("host worker shutting down");
  }

  // --- assets --------------------------------------------------------------

  private presentAssets(): Assets | null {
    const settings = this.config?.whisperCpp ?? null;
    const runtime = runtimeFor(settings);
    if (settings === null || runtime === null) return null;
    const model = this.models.presentFile(settings.model);
    const dir = this.runtimes.presentArchive(runtime);
    const server = dir === null ? null : findFile(dir, SERVER_NAME);
    return model === null || server === null ? null : { server, model };
  }

  /** Start the downloads unless they are running, or failed too recently (unless forced). */
  private startDownload(config: EngineConfig, force: boolean): void {
    if (this.assetsTask !== null) return;
    const error = this.assetError;
    if (!force && error !== null && Date.now() - error.at < retryDelay(error.permanent)) return;
    void this.ensureAssets(config).catch(() => {});
  }

  /** A failed download is tried again on its own, so the microphone comes back without a restart. */
  private scheduleRetry(permanent: boolean): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const config = this.config;
      if (config !== null && this.presentAssets() === null) this.startDownload(config, false);
    }, retryDelay(permanent));
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private ensureAssets(config: EngineConfig): Promise<Assets> {
    if (this.assetsTask !== null) return this.assetsTask;
    const task = (async (): Promise<Assets> => {
      const settings = config.whisperCpp;
      if (settings === null) throw new Error("the whisper.cpp engine has no download settings");
      const runtime = runtimeFor(settings);
      if (runtime === null) {
        throw Object.assign(
          new Error(`no whisper.cpp program is configured for this machine (${platformKey()})`),
          { permanent: true },
        );
      }
      const fetchOptions = {
        authHeader: settings.authHeader,
        onProgress: (progress: AssetProgress) => {
          this.progress = progress;
        },
      };
      this.progress = { label: "speech engine", doneBytes: 0, totalBytes: null };
      const dir = await this.runtimes.ensureArchive(runtime, "speech engine", fetchOptions);
      const server = findFile(dir, SERVER_NAME);
      if (server === null) {
        throw Object.assign(new Error(`the speech engine archive has no ${SERVER_NAME}`), { permanent: true });
      }
      this.progress = { label: "speech model", doneBytes: 0, totalBytes: null };
      const model =
        settings.model.parts.length > 0
          ? await this.models.ensureParted(
              { sha256: settings.model.sha256, name: modelName(settings.model), parts: settings.model.parts },
              "speech model",
              fetchOptions,
            )
          : await this.models.ensureFile(settings.model, "speech model", fetchOptions);
      // Only now that the new files are in place do the old versions go.
      await this.runtimes.prune([runtime.sha256]);
      await this.models.prune([settings.model.sha256]);
      this.options.log("speech engine files ready", { server: basename(server), model: basename(model) });
      return { server, model };
    })();
    this.assetsTask = task;
    task.then(
      () => {
        this.assetError = null;
        this.clearRetry();
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const permanent = Boolean((error as { permanent?: boolean } | null)?.permanent);
        this.assetError = { message, at: Date.now(), permanent };
        this.options.log("speech engine download failed", { message, permanent });
        this.scheduleRetry(permanent);
      },
    ).finally(() => {
      this.assetsTask = null;
      this.progress = null;
    });
    return task;
  }

  // --- the server ----------------------------------------------------------

  private ensureStarted(config: EngineConfig): Promise<void> {
    if (this.child !== null && this.state === "ready") return Promise.resolve();
    if (this.starting !== null) return this.starting;
    const startup = this.start(config).finally(() => {
      this.starting = null;
    });
    this.starting = startup;
    return startup;
  }

  private async start(config: EngineConfig): Promise<void> {
    const assets = this.presentAssets() ?? (await this.ensureAssets(config));
    this.state = "loading";
    this.message = null;
    const port = await freePort();
    const threads = Math.max(1, config.threads * config.parallel);
    const args = [
      "-m",
      assets.model,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-t",
      String(threads),
      "-l",
      config.language ?? "auto",
    ];
    const child = spawn(assets.server, args, {
      cwd: dirname(assets.server),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Builds with OpenMP spin on idle cores by default, which costs a lot when
      // the agents are busy too; ours have none, but a mirrored build might.
      env: { ...process.env, OMP_WAIT_POLICY: "PASSIVE" },
    });
    this.child = child;
    this.port = port;
    this.serverPath = assets.server;
    this.outputTail = [];
    try {
      if (child.pid !== undefined) os.setPriority(child.pid, 10);
    } catch {
      // Priorities are advisory.
    }
    this.lease = this.options.retainWorker();
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        this.outputTail.push(line.trim());
        if (this.outputTail.length > OUTPUT_TAIL_LINES) this.outputTail.shift();
      }
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);

    const exited = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        this.onGone(child, `could not start the speech engine: ${error.message}`);
        reject(new Error(`could not start the speech engine: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        // 0xC0000135: Windows could not find a DLL the program needs.
        const missingDll = code === 3_221_225_781 ? "; a library it needs is missing (the Visual C++ runtime?)" : "";
        const reason = `speech engine exited (${signal ?? `code ${code ?? "null"}`})${missingDll}${this.tail()}`;
        this.onGone(child, reason);
        reject(new Error(reason));
      });
    });
    exited.catch(() => {});

    try {
      await Promise.race([waitHealthy(port, READY_TIMEOUT_MS), exited]);
    } catch (error) {
      await this.stop("startup failed");
      this.state = "failed";
      this.message = error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.state = "ready";
    this.options.log("speech engine ready", { model: basename(assets.model), threads, port });
    this.scheduleIdleUnload();
  }

  private tail(): string {
    const text = this.outputTail.slice(-4).join(" | ");
    return text === "" ? "" : `: ${text}`;
  }

  private onGone(child: ChildProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.port = null;
    this.state = this.state === "ready" ? "idle" : this.state;
    this.message = reason;
    this.clearIdleUnload();
    const lease = this.lease;
    this.lease = null;
    void lease?.dispose().catch(() => {});
  }

  private async stop(reason: string): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.onGone(child, reason);
    this.state = "idle";
    await terminate(child, STOP_GRACE_MS);
  }

  // --- recognition ---------------------------------------------------------

  private async run(
    args: TranscribeArgs,
    config: EngineConfig,
    onPartial: (text: string) => void,
  ): Promise<TranscriptionResult> {
    const started = Date.now();
    let samples: Float32Array;
    try {
      samples = await decodeToMono16k(new Uint8Array(Buffer.from(args.audioBase64, "base64")));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure("request_failed", error instanceof AudioFormatError ? message : `could not read the recording: ${message}`);
    }
    const audioSec = round(samples.length / SAMPLE_RATE);
    if (samples.length === 0 || !hasSpeech(samples)) {
      return { ok: true, text: "", audioSec, elapsedSec: round((Date.now() - started) / 1000) };
    }

    try {
      await this.ensureStarted(config);
    } catch (error) {
      return failure("service_unavailable", error instanceof Error ? error.message : String(error));
    }

    const language = args.language ?? config.language;
    const prompt = promptFor(language, args.prompt ?? config.vocabulary);
    const paragraphs: string[][] = [[]];
    this.active++;
    this.clearIdleUnload();
    try {
      for (const piece of splitAtPauses(samples)) {
        const audio = samples.subarray(piece.start, piece.end);
        if (!hasSpeech(audio)) continue;
        const segments = await this.enqueue(() => this.infer(audio, language, prompt));
        if (piece.pauseBeforeSec >= config.paragraphPauseSec && (paragraphs.at(-1)?.length ?? 0) > 0) {
          paragraphs.push([]);
        }
        let previousEnd: number | null = null;
        for (const segment of segments) {
          if (
            previousEnd !== null &&
            segment.start - previousEnd >= config.paragraphPauseSec &&
            (paragraphs.at(-1)?.length ?? 0) > 0
          ) {
            paragraphs.push([]);
          }
          // Pieces are cut in pauses: a piece never continues the last word of the one before.
          paragraphs.at(-1)?.push(previousEnd === null ? ` ${segment.text}` : segment.text);
          previousEnd = segment.end;
        }
        onPartial(joinParagraphs(paragraphs));
      }
    } catch (error) {
      return failure("service_unavailable", error instanceof Error ? error.message : String(error));
    } finally {
      this.active--;
      this.scheduleIdleUnload();
    }
    return {
      ok: true,
      text: joinParagraphs(paragraphs),
      audioSec,
      elapsedSec: round((Date.now() - started) / 1000),
    };
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** One piece through the server: WAV in, segments with timestamps out. */
  private async infer(audio: Float32Array, language: string | null, prompt: string): Promise<Segment[]> {
    const port = this.port;
    if (port === null || this.child === null) throw new Error("the speech engine is not running");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(encodeWav16(audio))], { type: "audio/wav" }), "piece.wav");
    form.set("response_format", "verbose_json");
    form.set("temperature", "0.2");
    form.set("language", language ?? "auto");
    if (prompt !== "") form.set("prompt", prompt);
    let response: Response;
    let body: string;
    try {
      response = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(PIECE_TIMEOUT_MS),
      });
      body = await response.text();
    } catch (error) {
      if ((error as { name?: string } | null)?.name !== "TimeoutError") throw error;
      // A server stuck on one piece would hold every later dictation behind it.
      await this.stop("a piece took too long");
      throw new Error(
        `the speech engine spent over ${Math.round(PIECE_TIMEOUT_MS / 60_000)} minutes on one piece and was restarted`,
      );
    }
    if (!response.ok) throw new Error(`speech engine answered HTTP ${response.status}: ${body.slice(0, 200)}`);
    let parsed: { text?: unknown; segments?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new Error("speech engine returned an unreadable answer");
    }
    if (typeof parsed.error === "string") throw new Error(`speech engine: ${parsed.error}`);
    const segments: Segment[] = [];
    if (Array.isArray(parsed.segments)) {
      for (const raw of parsed.segments as Record<string, unknown>[]) {
        // whisper.cpp ends segments mid-word ("под" + "нимать"): keep the spacing it gives.
        const text = typeof raw.text === "string" ? raw.text : "";
        if (text.trim() === "") continue;
        segments.push({
          text,
          start: typeof raw.start === "number" ? raw.start : 0,
          end: typeof raw.end === "number" ? raw.end : 0,
        });
      }
    } else if (typeof parsed.text === "string" && parsed.text.trim() !== "") {
      segments.push({ text: parsed.text, start: 0, end: audio.length / SAMPLE_RATE });
    }
    const whole = segments.map((segment) => segment.text).join("").trim();
    if (HALLUCINATIONS.some((pattern) => pattern.test(whole))) return [];
    return segments;
  }

  private scheduleIdleUnload(): void {
    this.clearIdleUnload();
    const idleMs = this.config?.idleUnloadMs ?? 0;
    if (idleMs <= 0 || this.active > 0 || this.child === null) return;
    this.idleTimer = setTimeout(() => {
      this.options.log("unloading the idle speech engine");
      void this.stop("idle");
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdleUnload(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** The program archive configured for the machine this host runs on. */
function runtimeFor(settings: WhisperCppConfig | null | undefined): AssetSpec | null {
  if (settings === null || settings === undefined) return null;
  const spec = settings.runtimes[platformKey()];
  return spec === undefined || spec === null || spec.url === "" ? null : spec;
}

function lastSegment(url: string): string {
  try {
    return decodeURIComponent(basename(new URL(url).pathname));
  } catch {
    return basename(url);
  }
}

/**
 * The model's file name: from its address, or for a model in parts from the
 * first part with the part suffix taken off (`model.bin.part-aa`, `.part01`, `.001`).
 */
function modelName(model: WhisperCppConfig["model"]): string {
  if (model.url.trim() !== "") return lastSegment(model.url) || "model.bin";
  const first = model.parts[0];
  if (first === undefined) return "model.bin";
  const name = lastSegment(first.url).replace(/\.(part[-_.]?[a-z0-9]{1,4}|\d{2,4})$/i, "");
  return name === "" ? "model.bin" : name;
}

export function promptFor(language: string | null, vocabulary: string | null): string {
  const primer = language === null ? "" : (LANGUAGE_PROMPTS[language] ?? "");
  return [primer, vocabulary?.trim() ?? ""].filter((part) => part !== "").join(" ");
}

function joinParagraphs(paragraphs: string[][]): string {
  return paragraphs
    .map((parts) => parts.join("").replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
}

function describeProgress(progress: AssetProgress): string {
  const done = Math.round(progress.doneBytes / (1024 * 1024));
  if (progress.totalBytes === null || progress.totalBytes <= 0) return `downloading the ${progress.label}: ${done} MB`;
  const total = Math.round(progress.totalBytes / (1024 * 1024));
  const percent = Math.min(100, Math.floor((progress.doneBytes / progress.totalBytes) * 100));
  return `downloading the ${progress.label}: ${percent}% of ${total} MB`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function retryDelay(permanent: boolean): number {
  return permanent ? PERMANENT_RETRY_AFTER_MS : RETRY_AFTER_MS;
}

/** SIGTERM, then SIGKILL if the process is still there after the grace period. */
async function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  const running = () => child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), graceMs);
  });
  if ((await Promise.race([exited, grace])) === "late" && running()) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
  clearTimeout(timer);
}

async function waitHealthy(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the speech engine did not load the model within ${Math.round(timeoutMs / 1000)}s`);
}
