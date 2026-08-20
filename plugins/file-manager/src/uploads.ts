// src/uploads.ts — chunked, resumable uploads (§5.2).
//
// Invariants this file exists to guarantee:
//
//  1. **Nothing is ever buffered.** A chunk goes straight from the request's
//     web stream into a positional `createWriteStream(part, { flags: "r+",
//     start: offset })`. A 5 GB file costs the same memory as a 5 KB one.
//  2. **Positional writes, never append.** `"a"` would double-write a retried
//     chunk; `"r+" + start` makes a retry idempotent.
//  3. **The staged size is the single source of truth.** Sessions live in JSON
//     sidecars next to the part file — never in `bb.storage` — precisely so
//     that the streaming section touches no `bb.*` handle: `bb plugin reload`
//     drains in-flight handlers for only 5 s and then disposes plugin
//     resources under them. Raw fds survive that; a closed database handle
//     does not.
//  4. **A crash never loses bytes.** Every accepted chunk is fsync'ed before
//     the 200, so `received` is durable, and an interrupted upload resumes
//     from the part file's real size.
//  5. **One chunk at a time per upload.** The in-memory lock set turns a
//     racing second chunk into `409 upload_busy` instead of interleaved
//     writes.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  UPLOAD_ID_PATTERN,
  type FileEntry,
} from "../contract";
import { fmError, mapNodeError } from "./errors";
import { buildEntry } from "./listing";
import { uniqueName } from "./mutations";
import { getUploadsDir, resolveExistingDir, resolveNew, validateName } from "./root";
import type { SettingsModule } from "./settings";
import { publishFs } from "./signals";

/* ------------------------------------------------------------------ */
/* Session sidecars                                                    */
/* ------------------------------------------------------------------ */

/** `<ROOT>/.bb-file-manager/uploads/<uploadId>.json` (§5.2). */
export interface UploadSession {
  uploadId: string;
  /** Realpath'ed destination directory as it was at uploadCreate time. */
  dirPath: string;
  /** POSIX sub-path under dirPath for folder drops; "" for a plain file. */
  relativeDir: string;
  fileName: string;
  sizeBytes: number;
  lastModifiedMs: number;
  sessionKey: string;
  createdAtMs: number;
}

/** 24 h, per §5.2's GC rule. */
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Chunk outcomes — the §5.2 response table, as data                   */
/* ------------------------------------------------------------------ */

export interface ChunkRequest {
  /** Raw query value; validated here, not by the caller. */
  uploadId: string | null | undefined;
  /** Raw query value (string) or an already-parsed integer. */
  offset: string | number | null | undefined;
  /** The request body exactly as `c.req.raw.body` hands it over. */
  body: ReadableStream<Uint8Array> | null | undefined;
  /** `c.req.raw.signal` — aborted when the client disconnects. */
  signal?: AbortSignal | undefined;
}

export type ChunkOutcome =
  | { status: 200; body: { ok: true; uploadId: string; received: number } }
  | { status: 400; body: { ok: false; error: "invalid_params" } }
  | { status: 404; body: { ok: false; error: "upload_not_found" } }
  | {
      status: 409;
      body: { ok: false; error: "offset_mismatch" | "upload_busy"; expected: number };
    }
  | { status: 413; body: { ok: false; error: "size_mismatch" } }
  | { status: 499; body: { ok: false; error: "aborted"; received: number } }
  | { status: 500; body: { ok: false; error: "io_error"; message: string } };

/* ------------------------------------------------------------------ */
/* Module shape                                                        */
/* ------------------------------------------------------------------ */

export interface UploadCreateInput {
  dirPath: string;
  fileName: string;
  sizeBytes: number;
  lastModifiedMs: number;
  relativeDir: string;
}

export interface UploadCreateOutput {
  uploadId: string;
  receivedBytes: number;
  chunkSizeBytes: number;
  resumed: boolean;
}

export interface UploadStatusOutput {
  uploadId: string;
  receivedBytes: number;
  sizeBytes: number;
  dirPath: string;
  fileName: string;
}

export interface UploadFinishInput {
  uploadId: string;
  conflict: "rename" | "overwrite" | "fail";
}

export interface UploadsModule {
  /* --- contract handlers --- */
  uploadCreate(input: UploadCreateInput): Promise<UploadCreateOutput>;
  uploadStatus(input: { uploadId: string }): Promise<UploadStatusOutput>;
  uploadFinish(input: UploadFinishInput): Promise<{ entry: FileEntry }>;
  uploadAbort(input: { uploadId: string }): Promise<{ ok: true }>;

  /* --- byte route (src/http-routes.ts) --- */
  writeChunk(request: ChunkRequest): Promise<ChunkOutcome>;

  /* --- background --- */
  /** Drops sessions whose part file is older than the TTL. Returns the count. */
  sweep(): Promise<number>;

  /** Upload ids with a chunk (or a commit) in flight. Diagnostics/tests. */
  inFlight(): string[];
}

export interface UploadsOptions {
  /** Only `chunkSizeBytes()` is used; the full SettingsModule satisfies it. */
  settings: Pick<SettingsModule, "chunkSizeBytes">;
  /** Session lifetime for `sweep()`; defaults to 24 h. */
  sessionTtlMs?: number;
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Thrown by the limiter when a body would push the file past its size. */
class UploadOverflowError extends Error {
  constructor() {
    super("upload chunk exceeds the declared file size");
    this.name = "UploadOverflowError";
  }
}

/**
 * Caps a chunk at `remaining` bytes without buffering: the moment a buffer
 * would cross the line the stream errors, the pipeline tears down, and the
 * caller answers 413.
 */
function createLimiter(remaining: number): Transform {
  let left = remaining;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length > left) {
        callback(new UploadOverflowError());
        return;
      }
      left -= chunk.length;
      callback(null, chunk);
    },
  });
}

/**
 * `pipeline` tears the sink down when the limiter errors, but the fd can still
 * be closing when the promise rejects. A rollback `truncate()` must not race a
 * write that is already queued, so wait for the descriptor to be gone first.
 */
async function closeSink(sink: WriteStream): Promise<void> {
  if (sink.closed) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      resolve();
    };
    sink.once("close", done);
    sink.once("error", done);
    sink.destroy();
  });
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const name = (error as { name?: unknown }).name;
  return (
    code === "ABORT_ERR" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    name === "AbortError" ||
    name === "ResponseAborted"
  );
}

function parseOffset(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (!/^\d+$/u.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** §5.2's resume key: same (dir, sub-path, name, size, mtime) → same session. */
function sessionKeyOf(input: {
  dirPath: string;
  relativeDir: string;
  fileName: string;
  sizeBytes: number;
  lastModifiedMs: number;
}): string {
  return createHash("sha256")
    .update(
      [
        input.dirPath,
        input.relativeDir,
        input.fileName,
        String(input.sizeBytes),
        String(input.lastModifiedMs),
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
}

/**
 * Validate a folder-drop sub-path: POSIX separators, no traversal, every
 * component a legal single name. Returns the normalized form ("" when empty).
 */
export function normalizeRelativeDir(input: string): string {
  if (input === "") return "";
  if (input.includes("\\")) throw fmError("invalid_name", input);
  const segments = input.split("/").filter((segment) => segment !== "" && segment !== ".");
  for (const segment of segments) {
    if (segment === "..") throw fmError("invalid_path", input);
    validateName(segment);
  }
  return segments.join("/");
}

async function sizeOf(absolutePath: string): Promise<number | null> {
  try {
    return (await stat(absolutePath)).size;
  } catch {
    return null;
  }
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export async function createUploads(
  bb: BbPluginApi,
  options: UploadsOptions,
): Promise<UploadsModule> {
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = options.now ?? Date.now;
  /** §7.2: the chunk lock is in-memory and resets on reload, by design. */
  const locked = new Set<string>();

  // The staging directory is derived from the *current* root on every call
  // (getUploadsDir() reads it) — never cached — so tests can repoint the root
  // and a reload can never serve a stale path.
  async function stagingDir(): Promise<string> {
    const dir = getUploadsDir();
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      throw mapNodeError(error, dir);
    }
    return dir;
  }

  function partPathFor(uploadId: string): string {
    return path.join(getUploadsDir(), `${uploadId}.part`);
  }

  function sessionPathFor(uploadId: string): string {
    return path.join(getUploadsDir(), `${uploadId}.json`);
  }

  function chunkSize(): number {
    let configured = DEFAULT_CHUNK_BYTES;
    try {
      configured = options.settings.chunkSizeBytes();
    } catch {
      // A broken settings read must not stop an upload from starting.
    }
    if (!Number.isFinite(configured)) configured = DEFAULT_CHUNK_BYTES;
    return Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(configured)));
  }

  function isUploadId(candidate: unknown): candidate is string {
    return typeof candidate === "string" && UPLOAD_ID_PATTERN.test(candidate);
  }

  async function readSession(uploadId: string): Promise<UploadSession | null> {
    if (!isUploadId(uploadId)) return null;
    let raw: string;
    try {
      raw = await readFile(sessionPathFor(uploadId), "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<UploadSession>;
      if (
        typeof parsed.uploadId !== "string" ||
        typeof parsed.dirPath !== "string" ||
        typeof parsed.fileName !== "string" ||
        typeof parsed.sizeBytes !== "number"
      ) {
        return null;
      }
      return {
        uploadId: parsed.uploadId,
        dirPath: parsed.dirPath,
        relativeDir: typeof parsed.relativeDir === "string" ? parsed.relativeDir : "",
        fileName: parsed.fileName,
        sizeBytes: parsed.sizeBytes,
        lastModifiedMs: typeof parsed.lastModifiedMs === "number" ? parsed.lastModifiedMs : 0,
        sessionKey: typeof parsed.sessionKey === "string" ? parsed.sessionKey : "",
        createdAtMs: typeof parsed.createdAtMs === "number" ? parsed.createdAtMs : 0,
      };
    } catch {
      return null;
    }
  }

  async function dropSession(uploadId: string): Promise<void> {
    await rm(sessionPathFor(uploadId), { force: true }).catch(() => undefined);
    await rm(partPathFor(uploadId), { force: true }).catch(() => undefined);
  }

  /**
   * Find the resumable session for this exact (dir, sub-path, name, size,
   * mtime). Duplicates can exist when a session was locked at create time, so
   * the one with the most staged bytes wins — never a readdir-order accident.
   */
  async function findByKey(dir: string, sessionKey: string): Promise<UploadSession | null> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    let best: UploadSession | null = null;
    let bestStaged = -1;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const uploadId = name.slice(0, -".json".length);
      const session = await readSession(uploadId);
      if (!session || session.sessionKey !== sessionKey) continue;
      const staged = (await sizeOf(partPathFor(uploadId))) ?? -1;
      if (staged > bestStaged) {
        best = session;
        bestStaged = staged;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* uploadCreate                                                      */
  /* ---------------------------------------------------------------- */

  async function uploadCreate(input: UploadCreateInput): Promise<UploadCreateOutput> {
    // The destination is resolved here to fail fast, and *again* at finish —
    // §6 rule 8: the directory may be renamed while the bytes are in flight.
    const dirReal = await resolveExistingDir(input.dirPath);
    validateName(input.fileName);
    const relativeDir = normalizeRelativeDir(input.relativeDir);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw fmError("invalid_path", `sizeBytes ${String(input.sizeBytes)}`);
    }

    const sessionKey = sessionKeyOf({
      dirPath: dirReal,
      relativeDir,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
      lastModifiedMs: input.lastModifiedMs,
    });

    const dir = await stagingDir();
    const existing = await findByKey(dir, sessionKey);
    if (existing) {
      const staged = await sizeOf(partPathFor(existing.uploadId));
      if (staged !== null && staged <= existing.sizeBytes && !locked.has(existing.uploadId)) {
        return {
          uploadId: existing.uploadId,
          receivedBytes: staged,
          chunkSizeBytes: chunkSize(),
          resumed: true,
        };
      }
      // Part file gone or longer than the declared size: the session is junk.
      if (!locked.has(existing.uploadId)) await dropSession(existing.uploadId);
    }

    const uploadId = randomBytes(16).toString("hex");
    const session: UploadSession = {
      uploadId,
      dirPath: dirReal,
      relativeDir,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
      lastModifiedMs: input.lastModifiedMs,
      sessionKey,
      createdAtMs: now(),
    };

    try {
      // Zero-length part file first: every later chunk uses flags "r+", which
      // requires the file to exist.
      const handle = await open(partPathFor(uploadId), "w");
      await handle.close();
      await writeFile(sessionPathFor(uploadId), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    } catch (error) {
      await dropSession(uploadId);
      throw mapNodeError(error, partPathFor(uploadId));
    }

    return { uploadId, receivedBytes: 0, chunkSizeBytes: chunkSize(), resumed: false };
  }

  /* ---------------------------------------------------------------- */
  /* uploadStatus                                                      */
  /* ---------------------------------------------------------------- */

  async function uploadStatus(input: { uploadId: string }): Promise<UploadStatusOutput> {
    const session = await readSession(input.uploadId);
    if (!session) throw fmError("upload_not_found", input.uploadId);
    const staged = await sizeOf(partPathFor(session.uploadId));
    if (staged === null) throw fmError("upload_not_found", input.uploadId);
    return {
      uploadId: session.uploadId,
      receivedBytes: staged,
      sizeBytes: session.sizeBytes,
      dirPath: session.dirPath,
      fileName: session.fileName,
    };
  }

  /* ---------------------------------------------------------------- */
  /* writeChunk — the streaming section (§5.2)                         */
  /* ---------------------------------------------------------------- */

  /**
   * NOTE: nothing in here touches `bb.*`. A reload drains in-flight handlers
   * for 5 s and then disposes plugin resources; raw fds are unaffected, plugin
   * handles are not.
   */
  async function writeChunk(request: ChunkRequest): Promise<ChunkOutcome> {
    const uploadId = request.uploadId;
    const offset = parseOffset(request.offset);
    if (!isUploadId(uploadId) || offset === null || request.body === null || request.body === undefined) {
      return { status: 400, body: { ok: false, error: "invalid_params" } };
    }

    const session = await readSession(uploadId);
    if (!session) return { status: 404, body: { ok: false, error: "upload_not_found" } };

    const partPath = partPathFor(uploadId);

    if (locked.has(uploadId)) {
      const current = (await sizeOf(partPath)) ?? 0;
      return { status: 409, body: { ok: false, error: "upload_busy", expected: current } };
    }
    locked.add(uploadId);
    try {
      const current = await sizeOf(partPath);
      // The sidecar exists but the part file does not: the session is dead.
      if (current === null) return { status: 404, body: { ok: false, error: "upload_not_found" } };
      if (current !== offset) {
        return { status: 409, body: { ok: false, error: "offset_mismatch", expected: current } };
      }

      const remaining = session.sizeBytes - offset;
      if (remaining < 0) return { status: 413, body: { ok: false, error: "size_mismatch" } };

      const source = Readable.fromWeb(request.body as unknown as NodeWebReadableStream<Uint8Array>);
      const sink = createWriteStream(partPath, { flags: "r+", start: offset });
      try {
        await pipeline(source, createLimiter(remaining), sink, { signal: request.signal });
      } catch (error) {
        if (error instanceof UploadOverflowError) {
          // A rejected chunk must not move the staged size by a single byte.
          // Truncating back to `session.sizeBytes` (what the §5.2 sketch says)
          // would leave the prefix of a *rejected* body staged and — since the
          // limiter never lets a write past the declared size through — mark
          // the session "complete", so the next uploadCreate resumes at 100 %
          // and uploadFinish commits rejected bytes as a successful upload.
          // Rolling back to `offset` is the same thing for the case the sketch
          // had in mind (offset === sizeBytes) and fail-closed for the rest.
          await closeSink(sink);
          await truncate(partPath, offset).catch(() => undefined);
          return { status: 413, body: { ok: false, error: "size_mismatch" } };
        }
        if (isAbortLike(error, request.signal)) {
          // §5.2: never delete the part file on abort — the surviving byte
          // count is exactly what makes the resume work.
          return {
            status: 499,
            body: { ok: false, error: "aborted", received: (await sizeOf(partPath)) ?? offset },
          };
        }
        return {
          status: 500,
          body: {
            ok: false,
            error: "io_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      // Durability: `received` must survive a power cut, because the client
      // treats it as the resume point.
      try {
        const handle = await open(partPath, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        return {
          status: 500,
          body: {
            ok: false,
            error: "io_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      return {
        status: 200,
        body: { ok: true, uploadId, received: (await sizeOf(partPath)) ?? offset },
      };
    } catch (error) {
      return {
        status: 500,
        body: {
          ok: false,
          error: "io_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      locked.delete(uploadId);
    }
  }

  /* ---------------------------------------------------------------- */
  /* uploadFinish                                                      */
  /* ---------------------------------------------------------------- */

  /** Create the folder-drop sub-path, one validated component at a time. */
  async function ensureRelativeDir(baseReal: string, relativeDir: string): Promise<string> {
    let current = baseReal;
    for (const segment of relativeDir.split("/").filter((part) => part !== "")) {
      const target = await resolveNew(current, segment);
      try {
        await mkdir(target);
      } catch (error) {
        const mapped = mapNodeError(error, target);
        if (mapped.code !== "exists") throw mapped;
      }
      current = await resolveExistingDir(target);
    }
    return current;
  }

  async function uploadFinish(input: UploadFinishInput): Promise<{ entry: FileEntry }> {
    const session = await readSession(input.uploadId);
    if (!session) throw fmError("upload_not_found", input.uploadId);
    if (locked.has(session.uploadId)) throw fmError("upload_busy", session.uploadId);

    locked.add(session.uploadId);
    try {
      const partPath = partPathFor(session.uploadId);
      const staged = await sizeOf(partPath);
      if (staged === null) throw fmError("upload_not_found", session.uploadId);
      if (staged !== session.sizeBytes) {
        throw fmError(
          "size_mismatch",
          `${session.fileName}: staged ${staged} of ${session.sizeBytes} bytes`,
        );
      }

      // Re-resolve now, not at create time: the directory may have moved.
      const baseReal = await resolveExistingDir(session.dirPath);
      const destDir = session.relativeDir
        ? await ensureRelativeDir(baseReal, session.relativeDir)
        : baseReal;

      let target = await resolveNew(destDir, session.fileName);
      if (await exists(target)) {
        if (input.conflict === "fail") throw fmError("exists", target);
        if (input.conflict === "rename") {
          target = await resolveNew(destDir, await uniqueName(destDir, session.fileName));
        } else {
          // overwrite: rename() replaces a regular file atomically, but not a
          // directory — remove whatever is there first.
          await rm(target, { recursive: true, force: true }).catch((error: unknown) => {
            throw mapNodeError(error, target);
          });
        }
      }

      try {
        await rename(partPath, target);
      } catch (error) {
        const mapped = mapNodeError(error, target);
        // §5.2 / §14 risk 7: a bind-mount under the root would make the commit
        // cross-device. copyFile streams in the kernel — still no buffering.
        if (mapped.code !== "cross_device") throw mapped;
        await copyFile(partPath, target);
        await unlink(partPath).catch(() => undefined);
      }

      await rm(sessionPathFor(session.uploadId), { force: true }).catch(() => undefined);
      publishFs(bb, [destDir], "upload");
      return { entry: await buildEntry(target) };
    } finally {
      locked.delete(session.uploadId);
    }
  }

  /* ---------------------------------------------------------------- */
  /* uploadAbort + GC                                                  */
  /* ---------------------------------------------------------------- */

  async function uploadAbort(input: { uploadId: string }): Promise<{ ok: true }> {
    if (!isUploadId(input.uploadId)) return { ok: true };
    // Drop the sidecar first: a chunk that is mid-flight then fails its next
    // session read instead of writing into an orphaned part file.
    await dropSession(input.uploadId);
    return { ok: true };
  }

  async function sweep(): Promise<number> {
    let dir: string;
    try {
      dir = await stagingDir();
    } catch {
      return 0;
    }
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }

    const cutoff = now() - sessionTtlMs;
    // A session owns two files; readdir order must not make it count twice.
    const seen = new Set<string>();
    let removed = 0;
    for (const name of names) {
      const match = /^([0-9a-f]{32})\.(json|part)$/u.exec(name);
      if (!match) continue;
      const uploadId = match[1] as string;
      if (locked.has(uploadId) || seen.has(uploadId)) continue;
      seen.add(uploadId);

      const partPath = partPathFor(uploadId);
      let mtimeMs: number | null = null;
      try {
        mtimeMs = (await stat(partPath)).mtimeMs;
      } catch {
        mtimeMs = null;
      }

      if (mtimeMs === null) {
        // No part file: the session is dead whatever its sidecar claims.
        await rm(sessionPathFor(uploadId), { force: true }).catch(() => undefined);
        removed += 1;
        continue;
      }
      if (mtimeMs >= cutoff) continue;
      await dropSession(uploadId);
      removed += 1;
    }
    if (removed > 0) bb.log.info(`upload gc: dropped ${removed} stale session(s)`);
    return removed;
  }

  // Make the staging area exist at load so the first chunk never races a mkdir.
  await stagingDir().catch((error: unknown) => {
    bb.log.warn(`upload staging directory unavailable: ${String(error)}`);
  });

  return {
    uploadCreate,
    uploadStatus,
    uploadFinish,
    uploadAbort,
    writeChunk,
    sweep,
    inFlight: () => [...locked],
  };
}
