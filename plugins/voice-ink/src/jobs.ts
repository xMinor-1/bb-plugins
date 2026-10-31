// What every engine does around one recognition, whatever runs the model:
// callers that bring the same audio share one job, a caller whose budget runs
// out gets what has been recognized so far, and the finished result reaches
// `onSettled` however long after the caller left.
import { createHash } from "node:crypto";
import type { TranscriptionResult } from "../contract.js";

/** Error codes bb's AI-service contract understands; `code` travels as-is. */
export type FailureCode =
  | "timeout"
  | "rate_limited"
  | "service_unavailable"
  | "auth_required"
  | "request_failed"
  | "invalid_response";

export function failure(code: FailureCode, message: string): TranscriptionResult {
  return { ok: false, code, message };
}

export function isFailureCode(value: unknown): value is FailureCode {
  return (
    value === "timeout" ||
    value === "rate_limited" ||
    value === "service_unavailable" ||
    value === "auth_required" ||
    value === "request_failed" ||
    value === "invalid_response"
  );
}

export interface TranscribeArgs {
  audioBase64: string;
  mimeType: string;
  language: string | null;
  prompt: string | null;
  timeoutMs: number;
  /**
   * Called once with the finished result, however long that takes and
   * whoever is still waiting — this is what lets a dictation bb gave up on
   * still reach the history.
   */
  onSettled?: (result: TranscriptionResult) => void;
}

/** One recognition, shared by every caller that arrives with the same audio. */
interface TranscriptionJob {
  work: Promise<TranscriptionResult>;
  startedAt: number;
  finishedAt: number | null;
  /** What has been recognized so far; handed over when the budget runs out. */
  partial: string | null;
}

/**
 * A caller may give up and ask again (bb before 0.46 allowed ten seconds per
 * attempt and retried once), so finished and in-flight work is kept under a
 * key derived from the audio: the retry finds the job already running and
 * waits for it instead of throwing the first attempt's work away.
 */
const JOB_RETENTION_MS = 10 * 60_000;

export class JobBoard {
  private readonly jobs = new Map<string, TranscriptionJob>();
  private lastText: string | null = null;

  /** The last transcript produced here, whatever became of its caller. */
  lastTranscript(): string | null {
    return this.lastText;
  }

  /**
   * Run (or join) the recognition of one payload. Never throws: failures come
   * back as results.
   *
   * `timeoutMs` bounds the wait, not the work. A caller that gives up leaves
   * the recognition running, and the next caller arriving with the same audio
   * joins it instead of starting over.
   */
  transcribe(
    args: TranscribeArgs,
    defaultLanguage: string | null,
    run: (onPartial: (text: string) => void) => Promise<TranscriptionResult>,
  ): Promise<TranscriptionResult> {
    const key = createHash("sha256")
      .update(args.audioBase64)
      .update(`|${args.language ?? defaultLanguage ?? ""}`)
      .digest("hex");

    this.forgetStale();
    let job = this.jobs.get(key);
    if (job === undefined) {
      const created: TranscriptionJob = {
        work: null as unknown as Promise<TranscriptionResult>,
        startedAt: Date.now(),
        finishedAt: null,
        partial: null,
      };
      created.work = run((text) => {
        created.partial = text;
      });
      this.jobs.set(key, created);
      void created.work.then(
        (result) => {
          created.finishedAt = Date.now();
          if (result.ok && result.text.trim() !== "") this.lastText = result.text;
          args.onSettled?.(result);
        },
        (error: unknown) => {
          created.finishedAt = Date.now();
          args.onSettled?.(
            failure("service_unavailable", error instanceof Error ? error.message : String(error)),
          );
        },
      );
      job = created;
    }

    const running = job;
    const waitedMs = Date.now() - running.startedAt;
    const budgetMs = Math.max(1_000, args.timeoutMs);
    return Promise.race([
      running.work,
      new Promise<TranscriptionResult>((resolve) => {
        const timer = setTimeout(() => {
          // bb 0.46 and later ask once and do not retry, so the caller gets
          // what has been recognized so far — a long dictation should not be
          // lost because the last sentence was still running. With nothing yet,
          // it is a timeout, and the job carries on for `onSettled`.
          const partial = running.partial;
          if (partial !== null && partial.trim() !== "") {
            resolve({ ok: true, text: partial.trim(), audioSec: 0, elapsedSec: 0, partial: true });
            return;
          }
          resolve(failure("timeout", `still transcribing after ${Math.round((waitedMs + budgetMs) / 1000)}s`));
        }, budgetMs);
        timer.unref?.();
        void running.work.finally(() => clearTimeout(timer));
      }),
    ]);
  }

  private forgetStale(): void {
    const now = Date.now();
    for (const [key, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > JOB_RETENTION_MS) this.jobs.delete(key);
    }
  }
}
