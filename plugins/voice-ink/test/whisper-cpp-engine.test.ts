// The whisper.cpp engine end to end, with a stand-in for whisper-server: the
// program and model come from a registry, the server starts on its own port,
// a long dictation goes in as pieces and comes back as paragraphs.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineConfig } from "../contract";
import { encodeWav16, SAMPLE_RATE } from "../src/audio";
import { platformKey, promptFor, WhisperCppEngine } from "../src/whisper-cpp-engine";
import { startDownloadServer, TOKEN, TOKEN_HEADER, type DownloadServer } from "./download-server";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Answers like whisper-server: /health, and /inference with verbose_json —
 * a piece says how long it was and what came with it, in two segments split
 * mid-word, as whisper.cpp does.
 */
const FAKE_SERVER = `
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const model = args[args.indexOf("-m") + 1];
createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200).end('{"status":"ok"}'); return; }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const text = body.toString("latin1");
    const field = (name) => { const m = new RegExp('name="' + name + '"\\\\r\\\\n\\\\r\\\\n([^\\\\r]*)').exec(text); return m ? m[1] : null; };
    const riff = body.indexOf("RIFF");
    const dataSize = body.readUInt32LE(riff + 40);
    const seconds = (dataSize / 2 / 16000).toFixed(1);
    const said = "piece " + seconds + "s lang=" + field("language") + " prompt=" + (field("prompt") ? "yes" : "no") + " model=" + model.split(/[\\\\/]/).pop();
    res.writeHead(200, { "content-type": "application/json" });
    const segments = [{ text: " " + said.slice(0, 3), start: 0, end: 0.1 }, { text: said.slice(3), start: 0.1, end: Number(seconds) }];
    res.end(JSON.stringify({ text: said, segments }));
  });
}).listen(port, "127.0.0.1");
`;

function tone(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < out.length; index++) out[index] = 0.3 * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE);
  return out;
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SAMPLE_RATE));
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const config = (whisperCpp: EngineConfig["whisperCpp"]): EngineConfig => ({
  engine: "whisper.cpp",
  whisperCpp,
  model: "small",
  computeType: "int8",
  threads: 2,
  parallel: 1,
  batchSize: 1,
  language: "ru",
  vocabulary: "Kubernetes",
  pythonPath: null,
  idleUnloadMs: 0,
  history: { enabled: false, maxEntries: 0, maxAgeDays: 0 },
  punctuate: true,
  paragraphPauseSec: 1.2,
  polish: { provider: "off", apiKey: null, model: "", baseUrl: null, extraInstruction: null },
});

let server: DownloadServer | null = null;
let engine: WhisperCppEngine | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await engine?.dispose();
  engine = null;
  await server?.close();
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.platform === "win32")("whisper.cpp engine", () => {
  it("downloads its files, starts the server and turns a long dictation into paragraphs", async () => {
    const launcher = `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-server.mjs" "$@"\n`;
    const archive = Buffer.from(
      zipSync({
        "whisper-cpp/whisper-server": new TextEncoder().encode(launcher),
        "whisper-cpp/fake-server.mjs": new TextEncoder().encode(FAKE_SERVER),
      }),
    );
    const model = randomBytes(256 * 1024);
    server = await startDownloadServer({ "engine.zip": archive, "ggml-test.bin": model });
    const dataDir = mkdtempSync(join(tmpdir(), "voice-ink-engine-"));
    dirs.push(dataDir);
    engine = new WhisperCppEngine({ dataDir, log: () => {}, retainWorker: () => ({ dispose: async () => {} }) });
    await engine.configure(
      config({
        model: { url: `${server.registry}ggml-test.bin`, sha256: sha(model) },
        runtimes: { [platformKey()]: { url: `${server.registry}engine.zip`, sha256: sha(archive) } },
        authHeader: `${TOKEN_HEADER}: ${TOKEN}`,
      }),
    );
    expect(engine.status().assetsReady).toBe(false);

    // Nobody waits minutes for a download inside a dictation: it starts, and the caller hears why.
    const early = await engine.transcribe({
      audioBase64: encodeWav16(tone(1)).toString("base64"),
      mimeType: "audio/wav",
      language: null,
      prompt: null,
      timeoutMs: 5_000,
    });
    expect(early.ok).toBe(false);
    await waitFor(() => engine?.status().assetsReady === true);

    const warm = await engine.warmUp();
    expect(warm.state).toBe("ready");
    expect(warm.runtimePath?.endsWith("whisper-server")).toBe(true);

    const short = await engine.transcribe({
      audioBase64: readFileSync(join(__dirname, "fixtures", "tone.webm")).toString("base64"),
      mimeType: "audio/webm",
      language: null,
      prompt: null,
      timeoutMs: 10_000,
    });
    expect(short).toMatchObject({ ok: true, text: "piece 1.5s lang=ru prompt=yes model=ggml-test.bin" });

    const partials: string[] = [];
    const long = concat(tone(18), silence(2), tone(18), silence(0.5), tone(10));
    const result = await engine.transcribe({
      audioBase64: encodeWav16(long).toString("base64"),
      mimeType: "audio/wav",
      language: null,
      prompt: null,
      timeoutMs: 20_000,
      onSettled: (settled) => partials.push(settled.ok ? "settled" : settled.message),
    });
    expect(result.ok).toBe(true);
    const paragraphs = result.ok ? result.text.split("\n\n") : [];
    // The two-second pause starts a paragraph; the half-second one does not.
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[1]?.split("piece").length).toBe(3);
    await waitFor(() => partials.includes("settled"));
  });

  it("reports a machine it has no program for instead of downloading", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "voice-ink-engine-"));
    dirs.push(dataDir);
    engine = new WhisperCppEngine({ dataDir, log: () => {}, retainWorker: () => ({ dispose: async () => {} }) });
    await engine.configure(
      config({ model: { url: "https://example.invalid/m.bin", sha256: "a".repeat(64) }, runtimes: {}, authHeader: null }),
    );
    await engine.warmUp();
    await waitFor(() => engine?.status().state === "failed");
    expect(engine.status().message).toMatch(/no whisper\.cpp program is configured for this machine/);
  });

  it("primes the model in the spoken language, as VoiceInk does", () => {
    expect(promptFor("ru", "Kubernetes, PostgreSQL")).toBe("Здравствуйте, как ваши дела? Приятно познакомиться. Kubernetes, PostgreSQL");
    expect(promptFor(null, null)).toBe("");
  });
});
