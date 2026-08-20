// test/backend/jobs.test.ts — the in-memory job registry (§7.2, §7.3).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_CHANNEL, jobSchema } from "../../contract";
import { createJobs, type JobsModule } from "../../src/jobs";

let host: ReturnType<typeof createFakePluginHost>;
let jobs: JobsModule;

function publishedJobs(): unknown[] {
  return host.harness.inspection.realtimeSignals
    .filter((signal) => signal.channel === JOB_CHANNEL)
    .map((signal) => signal.payload);
}

beforeEach(() => {
  host = createFakePluginHost({ pluginId: "file-manager" });
  jobs = createJobs(host.bb);
});

afterEach(async () => {
  await host.harness.lifecycle.dispose();
});

describe("createJobs", () => {
  it("creates a running job that satisfies the wire schema and publishes it", () => {
    const job = jobs.create({ label: 'Extracting "a.zip"', totalBytes: 1024 });

    expect(jobSchema.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({
      kind: "extract",
      state: "running",
      label: 'Extracting "a.zip"',
      finishedAtMs: null,
      processedBytes: 0,
      totalBytes: 1024,
      resultPath: null,
      errorCode: null,
      errorMessage: null,
    });
    expect(publishedJobs()).toEqual([JSON.parse(JSON.stringify(job))]);
  });

  it("answers jobStatus for a known id and null for an unknown one", () => {
    const job = jobs.create({ label: "x" });
    expect(jobs.jobStatus({ jobId: job.jobId }).job).toMatchObject({ jobId: job.jobId });
    // §7.2: an unknown id is not an error — the panel refetches instead.
    expect(jobs.jobStatus({ jobId: "missing" })).toEqual({ job: null });
    expect(jobs.jobCancel({ jobId: "missing" })).toEqual({ job: null });
  });

  it("moves running → done and reports 100% when totalBytes is known", () => {
    const job = jobs.create({ label: "x", totalBytes: 500 });
    jobs.progress(job.jobId, 250);
    const done = jobs.succeed(job.jobId, "/home/coder/out");

    expect(done).toMatchObject({
      state: "done",
      resultPath: "/home/coder/out",
      processedBytes: 500,
    });
    expect(done?.finishedAtMs).toBeTypeOf("number");
    expect(publishedJobs()).toHaveLength(3); // create, progress, done
  });

  it("moves running → failed with a contract error code", () => {
    const job = jobs.create({ label: "x" });
    const failed = jobs.fail(job.jobId, "archive_failed", "tar exited 2");

    expect(failed).toMatchObject({
      state: "failed",
      errorCode: "archive_failed",
      errorMessage: "tar exited 2",
    });
    expect(jobSchema.safeParse(failed).success).toBe(true);
  });

  it("cancels a running job, runs the canceller, and freezes the terminal state", async () => {
    const kill = vi.fn();
    const job = jobs.create({ label: "x" });
    jobs.onCancel(job.jobId, kill);

    const canceled = jobs.jobCancel({ jobId: job.jobId });
    expect(canceled.job).toMatchObject({ state: "canceled" });
    expect(jobs.isCanceled(job.jobId)).toBe(true);
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));

    // A terminal job never moves again — the extraction's own completion
    // handler must not turn a cancel into a failure.
    expect(jobs.fail(job.jobId, "io_error", "late")).toMatchObject({ state: "canceled" });
    expect(jobs.succeed(job.jobId, "/tmp")).toMatchObject({ state: "canceled" });
    expect(jobs.progress(job.jobId, 10)).toMatchObject({ processedBytes: 0 });
    expect(jobs.jobCancel({ jobId: job.jobId }).job).toMatchObject({ state: "canceled" });
  });

  it("runs a canceller registered after the job was already canceled", async () => {
    const kill = vi.fn();
    const job = jobs.create({ label: "x" });
    jobs.jobCancel({ jobId: job.jobId });

    // The race the extraction really has: cancel lands between spawn and the
    // onCancel registration.
    jobs.onCancel(job.jobId, kill);
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
  });

  it("survives a canceller that throws", async () => {
    const job = jobs.create({ label: "x" });
    jobs.onCancel(job.jobId, () => {
      throw new Error("kill failed");
    });
    expect(jobs.jobCancel({ jobId: job.jobId }).job).toMatchObject({ state: "canceled" });
    await vi.waitFor(() =>
      expect(
        host.harness.inspection.logEntries.some((entry) => entry.message.includes("kill failed")),
      ).toBe(true),
    );
  });

  it("keeps running jobs when the retention cap prunes terminal ones", () => {
    const bounded = createJobs(host.bb, { maxJobs: 3 });
    const kept = bounded.create({ label: "running" });
    for (let index = 0; index < 5; index += 1) {
      const job = bounded.create({ label: `done-${index}` });
      bounded.succeed(job.jobId, null);
    }

    expect(bounded.list().length).toBeLessThanOrEqual(3);
    expect(bounded.jobStatus({ jobId: kept.jobId }).job).toMatchObject({ state: "running" });
  });
});
