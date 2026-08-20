// test/backend/uploads.test.ts — §11.1's uploads row.
//
// Everything runs against a real mkdtemp tree with the real root module
// (initRoot points it at the temp dir), so path resolution, the sidecar
// layout and the positional writes are all exercised for real.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STAGING_DIR_NAME } from "../../contract";
import { initRoot } from "../../src/root";
import { createUploads, normalizeRelativeDir, type UploadsModule } from "../../src/uploads";

let root: string;
let uploads: UploadsModule;
let host: ReturnType<typeof createFakePluginHost>;

const CHUNK_SETTINGS = { chunkSizeBytes: () => 8 * 1024 * 1024 };

function uploadsDir(): string {
  return path.join(root, STAGING_DIR_NAME, "uploads");
}

function partPath(uploadId: string): string {
  return path.join(uploadsDir(), `${uploadId}.part`);
}

function sessionPath(uploadId: string): string {
  return path.join(uploadsDir(), `${uploadId}.json`);
}

/** One-shot web body, exactly what `c.req.raw.body` looks like to writeChunk. */
function body(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}

function createGate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

/** A body that yields `first`, then blocks until the gate opens. */
function gatedBody(first: Uint8Array, gate: Gate): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return undefined;
      }
      return gate.promise.then(() => {
        try {
          controller.close();
        } catch {
          // The pipeline may already have torn the stream down.
        }
      });
    },
  });
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function sizeOf(candidate: string): Promise<number> {
  return (await stat(candidate)).size;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-uploads-")));
  await initRoot(root);
  host = createFakePluginHost({ pluginId: "file-manager" });
  uploads = await createUploads(host.bb, { settings: CHUNK_SETTINGS });
});

afterEach(async () => {
  await host.harness.lifecycle.dispose();
});

describe("uploadCreate", () => {
  it("stages a zero-length part file plus a session sidecar", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "notes.txt",
      sizeBytes: 12,
      lastModifiedMs: 1_700_000_000_000,
      relativeDir: "",
    });

    expect(created.uploadId).toMatch(/^[0-9a-f]{32}$/u);
    expect(created.receivedBytes).toBe(0);
    expect(created.resumed).toBe(false);
    // §5.2: the server-preferred chunk size, clamped into [4 MiB, 64 MiB].
    expect(created.chunkSizeBytes).toBe(8 * 1024 * 1024);

    expect(await sizeOf(partPath(created.uploadId))).toBe(0);
    const session = JSON.parse(await readFile(sessionPath(created.uploadId), "utf8")) as Record<
      string,
      unknown
    >;
    expect(session).toMatchObject({
      uploadId: created.uploadId,
      dirPath: root,
      relativeDir: "",
      fileName: "notes.txt",
      sizeBytes: 12,
      lastModifiedMs: 1_700_000_000_000,
    });
    expect(session.sessionKey).toBe(
      createHash("sha256")
        .update([root, "", "notes.txt", "12", "1700000000000"].join("\0"), "utf8")
        .digest("hex"),
    );
  });

  it("resumes the same session for a repeated (dir, name, size, mtime) tuple", async () => {
    const first = await uploads.uploadCreate({
      dirPath: root,
      fileName: "big.bin",
      sizeBytes: 8,
      lastModifiedMs: 42,
      relativeDir: "",
    });
    const outcome = await uploads.writeChunk({
      uploadId: first.uploadId,
      offset: "0",
      body: body(new Uint8Array([1, 2, 3, 4])),
    });
    expect(outcome.status).toBe(200);

    // A page reload re-issues uploadCreate with the same tuple.
    const second = await uploads.uploadCreate({
      dirPath: root,
      fileName: "big.bin",
      sizeBytes: 8,
      lastModifiedMs: 42,
      relativeDir: "",
    });
    expect(second.uploadId).toBe(first.uploadId);
    expect(second.receivedBytes).toBe(4);
    expect(second.resumed).toBe(true);

    // A different mtime is a different file: new session, nothing resumed.
    const third = await uploads.uploadCreate({
      dirPath: root,
      fileName: "big.bin",
      sizeBytes: 8,
      lastModifiedMs: 43,
      relativeDir: "",
    });
    expect(third.uploadId).not.toBe(first.uploadId);
    expect(third.resumed).toBe(false);
  });

  it("rejects a destination outside the root and an illegal file name", async () => {
    await expect(
      uploads.uploadCreate({
        dirPath: "/etc",
        fileName: "passwd",
        sizeBytes: 1,
        lastModifiedMs: 0,
        relativeDir: "",
      }),
    ).rejects.toThrow(/^path_escape: /u);

    await expect(
      uploads.uploadCreate({
        dirPath: root,
        fileName: "../escape.txt",
        sizeBytes: 1,
        lastModifiedMs: 0,
        relativeDir: "",
      }),
    ).rejects.toThrow(/^invalid_name: /u);
  });

  it("validates folder-drop sub-paths", () => {
    expect(normalizeRelativeDir("")).toBe("");
    expect(normalizeRelativeDir("photos//2024/")).toBe("photos/2024");
    expect(normalizeRelativeDir("./photos")).toBe("photos");
    expect(() => normalizeRelativeDir("../etc")).toThrow(/^invalid_path: /u);
    expect(() => normalizeRelativeDir("photos/../..")).toThrow(/^invalid_path: /u);
  });
});

describe("writeChunk", () => {
  it("writes chunks in order and commits the exact bytes", async () => {
    const payload = randomBytes(3000);
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "payload.bin",
      sizeBytes: payload.length,
      lastModifiedMs: 7,
      relativeDir: "",
    });

    const first = await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: "0",
      body: body(new Uint8Array(payload.subarray(0, 1024))),
    });
    expect(first).toMatchObject({ status: 200, body: { ok: true, received: 1024 } });

    const second = await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: "1024",
      body: body(new Uint8Array(payload.subarray(1024))),
    });
    expect(second).toMatchObject({ status: 200, body: { ok: true, received: payload.length } });

    const finished = await uploads.uploadFinish({
      uploadId: created.uploadId,
      conflict: "rename",
    });
    expect(finished.entry.path).toBe(path.join(root, "payload.bin"));
    expect(finished.entry.sizeBytes).toBe(payload.length);
    expect(finished.entry.kind).toBe("file");
    expect(await readFile(path.join(root, "payload.bin"))).toEqual(payload);

    // The commit is a rename: nothing is left behind in the staging area.
    expect(await readdir(uploadsDir())).toEqual([]);
  });

  it("answers 409 offset_mismatch with the authoritative offset for an out-of-order chunk", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "ordered.bin",
      sizeBytes: 12,
      lastModifiedMs: 0,
      relativeDir: "",
    });

    // The client jumps ahead: chunk 2 arrives before chunk 1.
    const ahead = await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: "8",
      body: body(new Uint8Array([9, 9, 9, 9])),
    });
    expect(ahead).toEqual({
      status: 409,
      body: { ok: false, error: "offset_mismatch", expected: 0 },
    });
    // Nothing was written: a rejected chunk must not move the offset.
    expect(await sizeOf(partPath(created.uploadId))).toBe(0);

    await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    });
    // A replayed chunk is rejected with the offset the client should use.
    const replay = await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([1, 2, 3, 4])),
    });
    expect(replay).toEqual({
      status: 409,
      body: { ok: false, error: "offset_mismatch", expected: 8 },
    });
  });

  it("resumes from the surviving byte count after a client disconnect", async () => {
    const payload = randomBytes(64);
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "resumed.bin",
      sizeBytes: payload.length,
      lastModifiedMs: 0,
      relativeDir: "",
    });

    const gate = createGate();
    const controller = new AbortController();
    const pending = uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: gatedBody(new Uint8Array(payload.subarray(0, 16)), gate),
      signal: controller.signal,
    });

    await waitFor(async () => (await sizeOf(partPath(created.uploadId))) === 16, "first bytes");
    controller.abort();
    const aborted = await pending;
    gate.open();

    // §5.2: 499, the part file survives, and `received` is authoritative.
    expect(aborted).toEqual({
      status: 499,
      body: { ok: false, error: "aborted", received: 16 },
    });
    expect(await sizeOf(partPath(created.uploadId))).toBe(16);

    const status = await uploads.uploadStatus({ uploadId: created.uploadId });
    expect(status).toMatchObject({ receivedBytes: 16, sizeBytes: 64, fileName: "resumed.bin" });

    const rest = await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: status.receivedBytes,
      body: body(new Uint8Array(payload.subarray(16))),
    });
    expect(rest).toMatchObject({ status: 200, body: { received: 64 } });

    await uploads.uploadFinish({ uploadId: created.uploadId, conflict: "fail" });
    expect(await readFile(path.join(root, "resumed.bin"))).toEqual(payload);
  });

  it("answers 409 upload_busy while another chunk for the same upload is in flight", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "busy.bin",
      sizeBytes: 32,
      lastModifiedMs: 0,
      relativeDir: "",
    });

    const gate = createGate();
    const pending = uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: gatedBody(new Uint8Array(randomBytes(8)), gate),
    });
    await waitFor(() => uploads.inFlight().includes(created.uploadId), "the chunk lock");

    const second = await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([1, 2, 3])),
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "upload_busy" });

    gate.open();
    expect((await pending).status).toBe(200);
    expect(uploads.inFlight()).toEqual([]);
  });

  it("answers 413 and never grows past the declared size", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "toobig.bin",
      sizeBytes: 4,
      lastModifiedMs: 0,
      relativeDir: "",
    });

    const outcome = await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    });
    expect(outcome).toEqual({ status: 413, body: { ok: false, error: "size_mismatch" } });
    expect(await sizeOf(partPath(created.uploadId))).toBeLessThanOrEqual(4);
  });

  it("rolls a rejected chunk back to its offset instead of staging it", async () => {
    const create = {
      dirPath: root,
      fileName: "over.bin",
      sizeBytes: 4,
      lastModifiedMs: 0,
      relativeDir: "",
    };
    const created = await uploads.uploadCreate(create);
    // One legal chunk first, so the rejected one starts at a non-zero offset.
    await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([1, 2])),
    });

    const outcome = await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 2,
      body: body(new Uint8Array([3, 4, 5, 6])),
    });
    expect(outcome).toEqual({ status: 413, body: { ok: false, error: "size_mismatch" } });

    // The rejected body must not have moved the staged size by a byte, or the
    // session resumes as "complete" and commits data nobody accepted.
    expect(await sizeOf(partPath(created.uploadId))).toBe(2);
    expect(await uploads.uploadStatus({ uploadId: created.uploadId })).toMatchObject({
      receivedBytes: 2,
    });
    expect(await uploads.uploadCreate(create)).toMatchObject({
      uploadId: created.uploadId,
      receivedBytes: 2,
      resumed: true,
    });
    await expect(
      uploads.uploadFinish({ uploadId: created.uploadId, conflict: "fail" }),
    ).rejects.toThrow(/^size_mismatch: /u);
  });

  it("rejects bad parameters, unknown ids and a missing body", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "params.bin",
      sizeBytes: 4,
      lastModifiedMs: 0,
      relativeDir: "",
    });

    expect(
      await uploads.writeChunk({ uploadId: "nope", offset: 0, body: body(new Uint8Array(1)) }),
    ).toEqual({ status: 400, body: { ok: false, error: "invalid_params" } });
    expect(
      await uploads.writeChunk({
        uploadId: created.uploadId,
        offset: "-1",
        body: body(new Uint8Array(1)),
      }),
    ).toEqual({ status: 400, body: { ok: false, error: "invalid_params" } });
    expect(
      await uploads.writeChunk({ uploadId: created.uploadId, offset: 0, body: null }),
    ).toEqual({ status: 400, body: { ok: false, error: "invalid_params" } });
    expect(
      await uploads.writeChunk({
        uploadId: "f".repeat(32),
        offset: 0,
        body: body(new Uint8Array(1)),
      }),
    ).toEqual({ status: 404, body: { ok: false, error: "upload_not_found" } });
  });
});

describe("uploadFinish", () => {
  it("applies the rename conflict policy", async () => {
    await writeFile(path.join(root, "notes.txt"), "original");
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "notes.txt",
      sizeBytes: 3,
      lastModifiedMs: 0,
      relativeDir: "",
    });
    await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([110, 101, 119])),
    });

    const finished = await uploads.uploadFinish({
      uploadId: created.uploadId,
      conflict: "rename",
    });
    expect(finished.entry.name).toBe("notes (1).txt");
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("original");
    expect(await readFile(path.join(root, "notes (1).txt"), "utf8")).toBe("new");
  });

  it("fails on conflict when asked to, and overwrites when asked to", async () => {
    await writeFile(path.join(root, "same.txt"), "old");

    const failing = await uploads.uploadCreate({
      dirPath: root,
      fileName: "same.txt",
      sizeBytes: 3,
      lastModifiedMs: 1,
      relativeDir: "",
    });
    await uploads.writeChunk({
      uploadId: failing.uploadId,
      offset: 0,
      body: body(new Uint8Array([97, 98, 99])),
    });
    await expect(
      uploads.uploadFinish({ uploadId: failing.uploadId, conflict: "fail" }),
    ).rejects.toThrow(/^exists: /u);

    const overwriting = await uploads.uploadCreate({
      dirPath: root,
      fileName: "same.txt",
      sizeBytes: 3,
      lastModifiedMs: 2,
      relativeDir: "",
    });
    await uploads.writeChunk({
      uploadId: overwriting.uploadId,
      offset: 0,
      body: body(new Uint8Array([120, 121, 122])),
    });
    await uploads.uploadFinish({ uploadId: overwriting.uploadId, conflict: "overwrite" });
    expect(await readFile(path.join(root, "same.txt"), "utf8")).toBe("xyz");
  });

  it("creates the folder-drop sub-path and publishes the fs signal", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "shot.png",
      sizeBytes: 2,
      lastModifiedMs: 0,
      relativeDir: "photos/2024",
    });
    await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([1, 2])),
    });
    const finished = await uploads.uploadFinish({
      uploadId: created.uploadId,
      conflict: "rename",
    });

    expect(finished.entry.path).toBe(path.join(root, "photos", "2024", "shot.png"));
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "fs",
      payload: { paths: [path.join(root, "photos", "2024")], reason: "upload" },
    });
  });

  it("refuses to commit a partial upload", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "partial.bin",
      sizeBytes: 10,
      lastModifiedMs: 0,
      relativeDir: "",
    });
    await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([1, 2, 3])),
    });
    await expect(
      uploads.uploadFinish({ uploadId: created.uploadId, conflict: "rename" }),
    ).rejects.toThrow(/^size_mismatch: /u);
  });

  it("re-resolves the destination at finish time", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "late.txt",
      sizeBytes: 1,
      lastModifiedMs: 0,
      relativeDir: "",
    });
    await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([65])),
    });

    // Point the session at a directory that no longer exists.
    const session = JSON.parse(await readFile(sessionPath(created.uploadId), "utf8")) as Record<
      string,
      unknown
    >;
    session.dirPath = path.join(root, "gone");
    await writeFile(sessionPath(created.uploadId), JSON.stringify(session), "utf8");

    await expect(
      uploads.uploadFinish({ uploadId: created.uploadId, conflict: "rename" }),
    ).rejects.toThrow(/^not_found: /u);
  });

  it("reports upload_not_found for an unknown id", async () => {
    await expect(
      uploads.uploadFinish({ uploadId: "a".repeat(32), conflict: "rename" }),
    ).rejects.toThrow(/^upload_not_found: /u);
    await expect(uploads.uploadStatus({ uploadId: "a".repeat(32) })).rejects.toThrow(
      /^upload_not_found: /u,
    );
  });
});

describe("uploadAbort and the GC sweep", () => {
  it("drops both sidecar files on abort", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "abandoned.bin",
      sizeBytes: 4,
      lastModifiedMs: 0,
      relativeDir: "",
    });
    await uploads.writeChunk({
      uploadId: created.uploadId,
      offset: 0,
      body: body(new Uint8Array([1, 2])),
    });

    expect(await uploads.uploadAbort({ uploadId: created.uploadId })).toEqual({ ok: true });
    expect(await readdir(uploadsDir())).toEqual([]);
    // Aborting twice is not an error.
    expect(await uploads.uploadAbort({ uploadId: created.uploadId })).toEqual({ ok: true });
  });

  it("sweeps sessions whose part file is older than the TTL and keeps fresh ones", async () => {
    const stale = await uploads.uploadCreate({
      dirPath: root,
      fileName: "stale.bin",
      sizeBytes: 4,
      lastModifiedMs: 0,
      relativeDir: "",
    });
    const fresh = await uploads.uploadCreate({
      dirPath: root,
      fileName: "fresh.bin",
      sizeBytes: 4,
      lastModifiedMs: 0,
      relativeDir: "",
    });

    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(partPath(stale.uploadId), old, old);

    expect(await uploads.sweep()).toBe(1);
    const remaining = (await readdir(uploadsDir())).sort();
    expect(remaining).toEqual([`${fresh.uploadId}.json`, `${fresh.uploadId}.part`]);
  });

  it("sweeps an orphaned sidecar whose part file is gone", async () => {
    const orphanId = "b".repeat(32);
    await writeFile(
      sessionPath(orphanId),
      JSON.stringify({
        uploadId: orphanId,
        dirPath: root,
        relativeDir: "",
        fileName: "orphan.bin",
        sizeBytes: 4,
        lastModifiedMs: 0,
        sessionKey: "x",
        createdAtMs: Date.now(),
      }),
      "utf8",
    );

    expect(await uploads.sweep()).toBe(1);
    expect(await readdir(uploadsDir())).toEqual([]);
  });
});
