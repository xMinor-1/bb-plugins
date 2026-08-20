// src/jobs.ts — the in-memory job registry (§7.2: "In-memory only:
// Map<jobId, Job> and Set<uploadId>"). Nothing here is persisted: a reload
// drops every job, `jobStatus` on an unknown id answers `{ job: null }`, and
// the panel then simply refetches the directory.
//
// Every transition publishes the whole job on the `job` realtime channel
// (§7.3), so the panel never has to poll unless it wants to.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { JOB_CHANNEL, type FileManagerErrorCode, type Job } from "../contract";

/** A job is terminal once it leaves `running`; terminal jobs never change. */
function isTerminal(job: Job): boolean {
  return job.state !== "running";
}

export interface CreateJobInput {
  kind?: Job["kind"];
  label: string;
  /** Archive size in bytes when known (0 otherwise). */
  totalBytes?: number;
}

export interface JobsModule {
  /* --- contract handlers (wired into bb.rpc by server.ts) --- */
  jobStatus(input: { jobId: string }): { job: Job | null };
  jobCancel(input: { jobId: string }): { job: Job | null };

  /* --- producer API, used by src/archives.ts --- */
  create(input: CreateJobInput): Job;
  get(jobId: string): Job | null;
  /** Bytes of the archive consumed so far; ignored once the job is terminal. */
  progress(jobId: string, processedBytes: number): Job | null;
  succeed(jobId: string, resultPath: string | null): Job | null;
  fail(jobId: string, code: FileManagerErrorCode, message: string): Job | null;
  /**
   * Register the "stop it now" action for a running job (killing a child
   * process, in practice). Replaces any previous canceller. Cleared when the
   * job becomes terminal.
   */
  onCancel(jobId: string, canceller: () => void | Promise<void>): void;
  /** True once jobCancel has moved the job to `canceled`. */
  isCanceled(jobId: string): boolean;
  /** Newest first. Diagnostics only — not part of the wire contract. */
  list(): Job[];
}

export interface JobsOptions {
  /** Injected for deterministic tests. */
  now?: () => number;
  /** Retention cap; the oldest terminal jobs are dropped past it. */
  maxJobs?: number;
}

const DEFAULT_MAX_JOBS = 200;

export function createJobs(bb: BbPluginApi, options: JobsOptions = {}): JobsModule {
  const now = options.now ?? Date.now;
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  /** Insertion-ordered (Map preserves it), which is also chronological order. */
  const jobs = new Map<string, Job>();
  const cancellers = new Map<string, () => void | Promise<void>>();

  function publish(job: Job): void {
    try {
      bb.realtime.publish(JOB_CHANNEL, job);
    } catch (error) {
      // Publishing is best-effort: a broken socket must not fail the work.
      bb.log.warn(`job signal for ${job.jobId} not published: ${String(error)}`);
    }
  }

  /** Bound retention so a long-lived server cannot grow the map without end. */
  function prune(): void {
    if (jobs.size <= maxJobs) return;
    for (const [jobId, job] of jobs) {
      if (jobs.size <= maxJobs) break;
      if (!isTerminal(job)) continue;
      jobs.delete(jobId);
      cancellers.delete(jobId);
    }
  }

  function settle(jobId: string, patch: Partial<Job>): Job | null {
    const job = jobs.get(jobId);
    if (!job || isTerminal(job)) return job ?? null;
    const next: Job = { ...job, ...patch };
    jobs.set(jobId, next);
    if (isTerminal(next)) cancellers.delete(jobId);
    publish(next);
    return next;
  }

  return {
    create(input) {
      const job: Job = {
        jobId: randomUUID(),
        kind: input.kind ?? "extract",
        state: "running",
        label: input.label,
        startedAtMs: now(),
        finishedAtMs: null,
        processedBytes: 0,
        totalBytes: input.totalBytes ?? 0,
        resultPath: null,
        errorCode: null,
        errorMessage: null,
      };
      jobs.set(job.jobId, job);
      prune();
      publish(job);
      return job;
    },

    get: (jobId) => jobs.get(jobId) ?? null,

    jobStatus: (input) => ({ job: jobs.get(input.jobId) ?? null }),

    jobCancel(input) {
      const job = jobs.get(input.jobId);
      if (!job) return { job: null };
      if (isTerminal(job)) return { job };

      // Read the canceller first: settle() drops it as part of going terminal.
      const canceller = cancellers.get(job.jobId);
      // Mark canceled *before* running the canceller: the extraction watches
      // isCanceled() when its child dies, and must not report `failed` for a
      // kill it asked for.
      const canceled = settle(job.jobId, { state: "canceled", finishedAtMs: now() });
      if (canceller) {
        void (async () => {
          try {
            await canceller();
          } catch (error) {
            bb.log.warn(`job ${job.jobId} canceller failed: ${String(error)}`);
          }
        })();
      }
      return { job: canceled };
    },

    progress(jobId, processedBytes) {
      return settle(jobId, { processedBytes: Math.max(0, Math.floor(processedBytes)) });
    },

    succeed(jobId, resultPath) {
      const job = jobs.get(jobId);
      if (!job || isTerminal(job)) return job ?? null;
      return settle(jobId, {
        state: "done",
        finishedAtMs: now(),
        resultPath,
        // A finished job reads as 100% even when progress was never reported.
        processedBytes: job.totalBytes > 0 ? job.totalBytes : job.processedBytes,
      });
    },

    fail(jobId, code, message) {
      return settle(jobId, {
        state: "failed",
        finishedAtMs: now(),
        errorCode: code,
        errorMessage: message,
      });
    },

    onCancel(jobId, canceller) {
      const job = jobs.get(jobId);
      if (!job || isTerminal(job)) {
        // Already canceled (or done) before the child even started: run the
        // stop action immediately instead of dropping it on the floor.
        void (async () => {
          try {
            await canceller();
          } catch (error) {
            bb.log.warn(`job ${jobId} canceller failed: ${String(error)}`);
          }
        })();
        return;
      }
      cancellers.set(jobId, canceller);
    },

    isCanceled(jobId) {
      return jobs.get(jobId)?.state === "canceled";
    },

    list: () => [...jobs.values()].reverse(),
  };
}
