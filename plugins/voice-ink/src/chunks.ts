// Cutting a recording into pieces Whisper reads in one pass.
//
// Whisper's encoder always looks at a 30-second window, so a piece shorter
// than that costs one pass and a longer one costs two. Long dictations are cut
// at pauses into pieces of at most 28 seconds: each piece is one pass, the
// text arrives piece by piece (what bb gets if it stops waiting), and a pause
// at a cut that is long enough starts a new paragraph.
//
// The thresholds match the browser side (lib/dictation.ts), which cuts the
// plugin's own button's audio the same way while the user talks.
import { SAMPLE_RATE } from "./audio.js";

const FRAME_MS = 20;
const FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;
/** Quieter than this (RMS of a frame) counts as a pause. */
const SILENCE_RMS = 0.006;
/** A piece is cut no earlier than this, so short pauses do not chop sentences. */
const MIN_PIECE_MS = 15_000;
/** And no later than this: one encoder window, with room to spare. */
const MAX_PIECE_MS = 28_000;
/** The quietest stretch this long between the limits is where a cut goes when no pause qualifies. */
const CUT_WINDOW_MS = 400;
/** Recordings whose loudest frame is below this hold no speech. */
const SPEECH_RMS = 0.01;

export interface Piece {
  /** Sample offsets into the recording. */
  start: number;
  end: number;
  /** Seconds of quiet just before this piece (0 for the first). */
  pauseBeforeSec: number;
}

function frameRms(samples: Float32Array): Float32Array {
  const count = Math.floor(samples.length / FRAME);
  const out = new Float32Array(count);
  for (let frame = 0; frame < count; frame++) {
    let sum = 0;
    const base = frame * FRAME;
    for (let index = 0; index < FRAME; index++) {
      const value = samples[base + index] as number;
      sum += value * value;
    }
    out[frame] = Math.sqrt(sum / FRAME);
  }
  return out;
}

/** True when some part of the recording is loud enough to be speech. */
export function hasSpeech(samples: Float32Array): boolean {
  const rms = frameRms(samples);
  for (const value of rms) if (value >= SPEECH_RMS) return true;
  return false;
}

/** Seconds of quiet around a frame: the run of quiet frames it sits in. */
function quietRunSec(rms: Float32Array, at: number): number {
  if (at < 0 || at >= rms.length || (rms[at] as number) >= SILENCE_RMS) return 0;
  let left = at;
  let right = at;
  while (left > 0 && (rms[left - 1] as number) < SILENCE_RMS) left--;
  while (right < rms.length - 1 && (rms[right + 1] as number) < SILENCE_RMS) right++;
  return ((right - left + 1) * FRAME_MS) / 1000;
}

/**
 * Pieces of at most 28 seconds, cut in the middle of the longest pause between
 * 15 and 28 seconds into the piece, or at the quietest moment there when the
 * speaker never stopped. Linear in the length of the recording.
 */
export function splitAtPauses(samples: Float32Array): Piece[] {
  const total = samples.length;
  const maxPiece = (MAX_PIECE_MS / 1000) * SAMPLE_RATE;
  if (total <= maxPiece) return [{ start: 0, end: total, pauseBeforeSec: 0 }];

  const rms = frameRms(samples);
  const minFrames = MIN_PIECE_MS / FRAME_MS;
  const maxFrames = MAX_PIECE_MS / FRAME_MS;
  const windowFrames = CUT_WINDOW_MS / FRAME_MS;
  const pieces: Piece[] = [];
  let startFrame = 0;
  let pauseBefore = 0;

  while ((rms.length - startFrame) * FRAME > maxPiece) {
    const from = startFrame + minFrames;
    const to = Math.min(rms.length - 1, startFrame + maxFrames);
    // The longest run of quiet frames in [from, to], by its middle.
    let bestRun = 0;
    let bestCut = -1;
    let runStart = -1;
    for (let frame = from; frame <= to + 1; frame++) {
      const quiet = frame <= to && (rms[frame] as number) < SILENCE_RMS;
      if (quiet && runStart === -1) runStart = frame;
      if (!quiet && runStart !== -1) {
        const run = frame - runStart;
        if (run > bestRun) {
          bestRun = run;
          bestCut = runStart + Math.floor(run / 2);
        }
        runStart = -1;
      }
    }
    let cut = bestCut;
    if (bestRun * FRAME_MS < 150) {
      // No real pause: the quietest 400 ms, found with a sliding sum.
      let sum = 0;
      let best = Number.POSITIVE_INFINITY;
      cut = to;
      for (let frame = from; frame <= to; frame++) {
        sum += rms[frame] as number;
        if (frame - from >= windowFrames) sum -= rms[frame - windowFrames] as number;
        if (frame - from >= windowFrames - 1 && sum < best) {
          best = sum;
          cut = frame - Math.floor(windowFrames / 2);
        }
      }
    }
    pieces.push({ start: startFrame * FRAME, end: cut * FRAME, pauseBeforeSec: pauseBefore });
    pauseBefore = quietRunSec(rms, cut);
    startFrame = cut;
  }
  pieces.push({ start: startFrame * FRAME, end: total, pauseBeforeSec: pauseBefore });
  return pieces;
}
