// Audio in, 16 kHz mono samples out — without Python or ffmpeg.
//
// bb's microphone button records in the browser, so what arrives is whatever
// MediaRecorder makes: WebM with Opus in Chromium and the desktop app, Ogg
// with Opus in Firefox. The plugin's own button and `bb voice-ink transcribe`
// may send WAV. whisper.cpp reads WAV, so the containers are taken apart here
// and Opus is decoded by libopus compiled to WebAssembly (opus-decoder), which
// resamples to 16 kHz itself.
//
// Anything else (Safari's MP4/AAC, for one) goes through ffmpeg when the
// machine has it, and is refused with a clear message when it does not.
//
// The parsers walk the bytes once, left to right, and check every length
// against what is left: a recording is input from outside the process.
import { spawn } from "node:child_process";
import { OpusDecoder } from "opus-decoder";

export const SAMPLE_RATE = 16_000;

/** Longer recordings are refused rather than decoded into gigabytes of samples. */
const MAX_SECONDS = 60 * 60;
const MAX_SAMPLES = MAX_SECONDS * SAMPLE_RATE;

export class AudioFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioFormatError";
  }
}

export type Container = "wav" | "webm" | "ogg" | "other";

export function sniffContainer(bytes: Uint8Array): Container {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "webm";
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") return "ogg";
  return "other";
}

/** Decode a recording to 16 kHz mono float samples in [-1, 1]. */
export async function decodeToMono16k(bytes: Uint8Array): Promise<Float32Array> {
  switch (sniffContainer(bytes)) {
    case "wav":
      return decodeWav(bytes);
    case "webm":
      return decodeOpus(demuxWebmOpus(bytes));
    case "ogg":
      return decodeOpus(demuxOggOpus(bytes));
    case "other":
      return decodeWithFfmpeg(bytes);
  }
}

// --- WAV -------------------------------------------------------------------

export function decodeWav(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: { tag: number; channels: number; rate: number; bits: number } | null = null;
  let data: { start: number; length: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const available = Math.min(size, bytes.length - start);
    if (id === "fmt " && available >= 16) {
      let tag = view.getUint16(start, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (tag === 0xfffe && available >= 26) tag = view.getUint16(start + 24, true);
      format = {
        tag,
        channels: view.getUint16(start + 2, true),
        rate: view.getUint32(start + 4, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (id === "data") {
      // Streaming writers leave the size at 0 or 0xFFFFFFFF; take the rest.
      const length = size === 0 || size === 0xffffffff ? bytes.length - start : available;
      data = { start, length };
      break;
    }
    offset = start + size + (size % 2);
  }
  if (format === null || data === null) throw new AudioFormatError("WAV file without fmt or data chunk");
  const { tag, channels, rate, bits } = format;
  if (channels < 1 || channels > 8 || rate < 4_000 || rate > 384_000) {
    throw new AudioFormatError(`unsupported WAV layout: ${channels} channels at ${rate} Hz`);
  }
  const bytesPerSample = bits / 8;
  const isFloat = tag === 3;
  if (!(tag === 1 && [8, 16, 24, 32].includes(bits)) && !(isFloat && (bits === 32 || bits === 64))) {
    throw new AudioFormatError(`unsupported WAV encoding: format ${tag}, ${bits} bits`);
  }
  const frames = Math.floor(data.length / (bytesPerSample * channels));
  if (frames > MAX_SECONDS * rate) throw new AudioFormatError(`recording is longer than ${MAX_SECONDS / 60} minutes`);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const at = data.start + (frame * channels + channel) * bytesPerSample;
      sum += readSample(view, at, bits, isFloat);
    }
    mono[frame] = sum / channels;
  }
  return resample(mono, rate, SAMPLE_RATE);
}

function readSample(view: DataView, at: number, bits: number, isFloat: boolean): number {
  if (isFloat) return bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
  switch (bits) {
    case 8:
      return (view.getUint8(at) - 128) / 128;
    case 16:
      return view.getInt16(at, true) / 32_768;
    case 24: {
      const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
      return value / 8_388_608;
    }
    default:
      return view.getInt32(at, true) / 2_147_483_648;
  }
}

/**
 * Linear interpolation, with a moving average in front when downsampling so
 * the higher frequencies do not fold back into the speech band.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  let source = input;
  if (from > to) {
    const width = Math.max(1, Math.round(from / to));
    if (width > 1) {
      source = new Float32Array(input.length);
      let sum = 0;
      for (let index = 0; index < input.length; index++) {
        sum += input[index] as number;
        if (index >= width) sum -= input[index - width] as number;
        source[index] = sum / Math.min(width, index + 1);
      }
    }
  }
  const length = Math.floor((source.length * to) / from);
  const output = new Float32Array(length);
  const step = from / to;
  for (let index = 0; index < length; index++) {
    const position = index * step;
    const left = Math.floor(position);
    const right = Math.min(left + 1, source.length - 1);
    const weight = position - left;
    output[index] = (source[left] as number) * (1 - weight) + (source[right] as number) * weight;
  }
  return output;
}

// --- Opus ------------------------------------------------------------------

interface OpusStream {
  channels: number;
  preSkip: number;
  frames: Uint8Array[];
}

/** The OpusHead packet both containers carry: channel count and pre-skip. */
function parseOpusHead(head: Uint8Array): { channels: number; preSkip: number } {
  if (head.length < 19 || ascii(head, 0, 8) !== "OpusHead") throw new AudioFormatError("Opus stream without an OpusHead");
  const channels = head[9] as number;
  const preSkip = (head[10] as number) | ((head[11] as number) << 8);
  const mapping = head[18] as number;
  if (channels < 1 || channels > 2 || mapping !== 0) {
    throw new AudioFormatError(`unsupported Opus layout: ${channels} channels, mapping family ${mapping}`);
  }
  return { channels, preSkip };
}

async function decodeOpus(stream: OpusStream): Promise<Float32Array> {
  if (stream.frames.length === 0) return new Float32Array(0);
  const decoder = new OpusDecoder({
    channels: stream.channels,
    preSkip: stream.preSkip,
    sampleRate: SAMPLE_RATE,
  });
  try {
    await decoder.ready;
    const decoded = decoder.decodeFrames(stream.frames);
    const length = Math.min(decoded.samplesDecoded, MAX_SAMPLES);
    const mono = new Float32Array(length);
    const channelData = decoded.channelData;
    for (const channel of channelData) {
      for (let index = 0; index < length; index++) mono[index] = (mono[index] as number) + (channel[index] as number);
    }
    if (channelData.length > 1) {
      for (let index = 0; index < length; index++) mono[index] = (mono[index] as number) / channelData.length;
    }
    return mono;
  } finally {
    decoder.free();
  }
}

// --- WebM (Matroska) -------------------------------------------------------

const EBML = {
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  cluster: 0x1f43b675,
  blockGroup: 0xa0,
  block: 0xa1,
  simpleBlock: 0xa3,
} as const;

/** Masters whose children matter; every other element is skipped whole. */
const DESCEND = new Set<number>([EBML.segment, EBML.tracks, EBML.trackEntry, EBML.cluster, EBML.blockGroup]);

interface VInt {
  value: number;
  length: number;
  /** All value bits set: an element of unknown size. */
  unknown: boolean;
}

/** An EBML variable-length integer; `keepMarker` for element ids, which keep it. */
function readVInt(bytes: Uint8Array, offset: number, keepMarker: boolean): VInt | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index] as number;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

export function demuxWebmOpus(bytes: Uint8Array): OpusStream {
  let offset = 0;
  interface Track {
    number: number | null;
    codec: string | null;
    head: Uint8Array | null;
  }
  let current: Track | null = null;
  const tracks: Track[] = [];
  const blocks: Uint8Array[] = [];

  while (offset < bytes.length) {
    const id = readVInt(bytes, offset, true);
    if (id === null) break;
    const size = readVInt(bytes, offset + id.length, false);
    if (size === null) break;
    const start = offset + id.length + size.length;

    if (DESCEND.has(id.value)) {
      if (id.value === EBML.trackEntry) {
        current = { number: null, codec: null, head: null };
        tracks.push(current);
      }
      offset = start;
      continue;
    }
    if (size.unknown) throw new AudioFormatError("WebM element of unknown size where a size is required");
    const end = start + size.value;
    if (end > bytes.length) break; // a recording cut short: keep what is whole
    const payload = bytes.subarray(start, end);
    if (current !== null) {
      if (id.value === EBML.trackNumber) current.number = readUInt(payload);
      else if (id.value === EBML.codecId) current.codec = ascii(payload, 0, payload.length);
      else if (id.value === EBML.codecPrivate) current.head = payload;
    }
    if (id.value === EBML.simpleBlock || id.value === EBML.block) blocks.push(payload);
    offset = end;
  }

  const opus = tracks.find((track) => track.codec === "A_OPUS");
  if (opus === undefined || opus.number === null) {
    const codecs = tracks.map((track) => track.codec ?? "?").join(", ");
    throw new AudioFormatError(`WebM recording has no Opus audio track${codecs === "" ? "" : ` (found: ${codecs})`}`);
  }
  const { channels, preSkip } = opus.head === null ? { channels: 1, preSkip: 0 } : parseOpusHead(opus.head);
  const frames: Uint8Array[] = [];
  for (const block of blocks) {
    const track = readVInt(block, 0, false);
    if (track === null || track.value !== opus.number) continue;
    const flags = block[track.length + 2] ?? 0;
    frames.push(...unlace(block, track.length + 3, (flags >> 1) & 3));
  }
  return { channels, preSkip, frames };
}

/** Split one Matroska block into its frames (no lacing, Xiph, fixed or EBML lacing). */
function unlace(block: Uint8Array, offset: number, lacing: number): Uint8Array[] {
  if (lacing === 0) return offset < block.length ? [block.subarray(offset)] : [];
  const count = (block[offset] ?? 0) + 1;
  let at = offset + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    for (let frame = 0; frame < count - 1; frame++) {
      let size = 0;
      let byte = 255;
      while (byte === 255 && at < block.length) {
        byte = block[at++] as number;
        size += byte;
      }
      sizes.push(size);
    }
  } else if (lacing === 3) {
    const first = readVInt(block, at, false);
    if (first === null) return [];
    sizes.push(first.value);
    at += first.length;
    for (let frame = 1; frame < count - 1; frame++) {
      const raw = readVInt(block, at, false);
      if (raw === null) return [];
      const bias = 2 ** (7 * raw.length - 1) - 1;
      sizes.push((sizes[frame - 1] as number) + raw.value - bias);
      at += raw.length;
    }
  } else {
    const each = Math.floor((block.length - at) / count);
    for (let frame = 0; frame < count - 1; frame++) sizes.push(each);
  }
  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    if (size < 0 || at + size > block.length) return frames;
    frames.push(block.subarray(at, at + size));
    at += size;
  }
  if (at < block.length) frames.push(block.subarray(at));
  return frames;
}

// --- Ogg -------------------------------------------------------------------

export function demuxOggOpus(bytes: Uint8Array): OpusStream {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let serial: number | null = null;
  let packet: Uint8Array[] = [];
  const packets: Uint8Array[] = [];

  while (offset + 27 <= bytes.length && ascii(bytes, offset, 4) === "OggS") {
    const pageSerial = view.getUint32(offset + 14, true);
    const segments = bytes[offset + 26] as number;
    const table = offset + 27;
    let at = table + segments;
    if (at > bytes.length) break;
    const mine = serial === null || serial === pageSerial;
    for (let segment = 0; segment < segments; segment++) {
      const length = bytes[table + segment] as number;
      if (at + length > bytes.length) break;
      if (mine) packet.push(bytes.subarray(at, at + length));
      at += length;
      if (mine && length < 255) {
        const whole = concat(packet);
        packet = [];
        if (serial === null) {
          if (whole.length < 8 || ascii(whole, 0, 8) !== "OpusHead") continue;
          serial = pageSerial;
        }
        packets.push(whole);
      }
    }
    offset = at;
  }

  const head = packets[0];
  if (head === undefined) throw new AudioFormatError("Ogg recording has no Opus stream");
  const { channels, preSkip } = parseOpusHead(head);
  // The second packet is OpusTags; audio starts after it.
  const frames = packets.slice(1).filter((candidate) => !(candidate.length >= 8 && ascii(candidate, 0, 8) === "OpusTags"));
  return { channels, preSkip, frames };
}

// --- anything else ---------------------------------------------------------

/** MP4/AAC and the rest: ffmpeg when the machine has it, a clear refusal when not. */
function decodeWithFfmpeg(bytes: Uint8Array): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
    } catch {
      reject(unsupported());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_SAMPLES * 4) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-500);
    });
    child.on("error", () => reject(unsupported()));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new AudioFormatError(`ffmpeg could not decode the recording: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      const joined = Buffer.concat(chunks);
      const samples = new Float32Array(Math.floor(joined.length / 4));
      for (let index = 0; index < samples.length; index++) samples[index] = joined.readFloatLE(index * 4);
      resolve(samples);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}

function unsupported(): AudioFormatError {
  return new AudioFormatError(
    "this recording format needs ffmpeg, which is not installed; WebM, Ogg (Opus) and WAV work without it",
  );
}

// --- WAV out ---------------------------------------------------------------

/** 16-bit PCM WAV, which is what whisper.cpp's server reads without ffmpeg. */
export function encodeWav16(samples: Float32Array, rate = SAMPLE_RATE): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index] as number));
    out.writeInt16LE(Math.round(clamped * 32_767), 44 + index * 2);
  }
  return out;
}

// --- helpers ---------------------------------------------------------------

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  const end = Math.min(bytes.length, offset + length);
  for (let index = offset; index < end; index++) text += String.fromCharCode(bytes[index] as number);
  return text;
}

function readUInt(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes.subarray(0, 6)) value = value * 256 + byte;
  return value;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
