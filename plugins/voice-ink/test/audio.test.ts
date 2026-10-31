// Decoding recordings without Python or ffmpeg: the containers browsers make,
// WAV in its common shapes, the pieces long dictations are cut into, and
// input that is not audio at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeToMono16k, decodeWav, encodeWav16, resample, SAMPLE_RATE, sniffContainer } from "../src/audio";
import { hasSpeech, splitAtPauses } from "../src/chunks";

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "fixtures", name)));

function tone(seconds: number, amplitude = 0.3, frequency = 220): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < out.length; index++) {
    out[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
  }
  return out;
}

function join16(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("decoding", () => {
  it("decodes WebM/Opus as Chromium records it", async () => {
    const bytes = fixture("tone.webm");
    expect(sniffContainer(bytes)).toBe("webm");
    const samples = await decodeToMono16k(bytes);
    expect(samples.length / SAMPLE_RATE).toBeGreaterThan(1.4);
    expect(samples.length / SAMPLE_RATE).toBeLessThan(1.6);
    expect(hasSpeech(samples)).toBe(true);
  });

  it("decodes stereo Ogg/Opus as Firefox records it, down to mono", async () => {
    const bytes = fixture("tone-stereo.ogg");
    expect(sniffContainer(bytes)).toBe("ogg");
    const samples = await decodeToMono16k(bytes);
    expect(samples.length / SAMPLE_RATE).toBeGreaterThan(1.4);
    expect(samples.length / SAMPLE_RATE).toBeLessThan(1.6);
  });

  it("round-trips 16-bit WAV and resamples other rates to 16 kHz", () => {
    const original = tone(0.5);
    const decoded = decodeWav(new Uint8Array(encodeWav16(original)));
    expect(decoded.length).toBe(original.length);
    expect(Math.abs((decoded[100] as number) - (original[100] as number))).toBeLessThan(1e-3);

    const at48k = encodeWav16(tone(1, 0.3, 220).subarray(0, 16_000), 48_000);
    expect(decodeWav(new Uint8Array(at48k)).length).toBe(Math.floor(16_000 / 3));
    expect(resample(new Float32Array(44_100), 44_100, 16_000).length).toBe(16_000);
  });

  it("refuses what is not a recording, quickly", async () => {
    const started = Date.now();
    await expect(decodeToMono16k(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0xff]))).rejects.toThrow(/Opus|WebM/);
    await expect(decodeToMono16k(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WAVEjunk"))).rejects.toThrow(/WAV/);
    const truncated = fixture("tone.webm").subarray(0, 2_000);
    const partial = await decodeToMono16k(truncated);
    expect(partial.length).toBeLessThan(SAMPLE_RATE * 1.5);
    const noise = new Uint8Array(2_000_000);
    for (let index = 0; index < noise.length; index++) noise[index] = (index * 2_654_435_761) >>> 24;
    noise.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    await decodeToMono16k(noise).catch(() => null);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("cutting at pauses", () => {
  it("keeps a recording under 28 seconds whole", () => {
    expect(splitAtPauses(tone(20))).toEqual([{ start: 0, end: 20 * SAMPLE_RATE, pauseBeforeSec: 0 }]);
  });

  it("cuts a long dictation in its pauses, never longer than 28 seconds", () => {
    const speech = join16(tone(18), new Float32Array(SAMPLE_RATE * 2), tone(18), new Float32Array(SAMPLE_RATE / 2), tone(10));
    const pieces = splitAtPauses(speech);
    expect(pieces.length).toBe(3);
    const first = pieces[0];
    expect(first).toBeDefined();
    // The cut falls inside the two-second pause, which then starts a paragraph.
    expect((first?.end ?? 0) / SAMPLE_RATE).toBeGreaterThan(18);
    expect((first?.end ?? 0) / SAMPLE_RATE).toBeLessThan(20);
    expect(pieces[1]?.pauseBeforeSec).toBeGreaterThan(1.5);
    expect(pieces[2]?.pauseBeforeSec).toBeGreaterThan(0.3);
    expect(pieces[2]?.pauseBeforeSec).toBeLessThan(0.7);
    for (const piece of pieces) expect((piece.end - piece.start) / SAMPLE_RATE).toBeLessThanOrEqual(28);
    expect(pieces.at(-1)?.end).toBe(speech.length);
  });

  it("still cuts a speaker who never pauses", () => {
    const pieces = splitAtPauses(tone(70));
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const piece of pieces) expect((piece.end - piece.start) / SAMPLE_RATE).toBeLessThanOrEqual(28);
    expect(pieces.at(-1)?.end).toBe(70 * SAMPLE_RATE);
  });

  it("finds no speech in silence", () => {
    expect(hasSpeech(new Float32Array(SAMPLE_RATE * 3))).toBe(false);
  });
});
