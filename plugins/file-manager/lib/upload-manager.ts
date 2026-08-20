// lib/upload-manager.ts — chunked, resumable, framework-free uploads.
//
// Why this file is shaped the way it is (all of it is §5.2 / §8.7 of SPEC.md):
//
//  * Node's `requestTimeout` kills any single request after 300 s, so a big
//    file MUST arrive as many bounded requests. Chunk size adapts to the
//    measured throughput and targets ~45 s per chunk, clamped to the contract's
//    [MIN_CHUNK_BYTES, MAX_CHUNK_BYTES].
//  * The chunk route uses `auth: "token"` (a raw body can never satisfy the
//    local-auth `content-type: application/json` rule), so the panel fetches
//    the plugin token once per session and re-fetches exactly once on a 401.
//  * XMLHttpRequest, not `fetch`: `fetch` with a Blob body reports no upload
//    progress, and byte-accurate progress is the whole point of the tray.
//  * The server owns the truth about how many bytes are staged. Every failure
//    path (409 `offset_mismatch`, 409 `upload_busy`, 499 `aborted`, a dropped
//    socket) re-syncs the client offset from `expected` / `received` / a fresh
//    `uploadStatus` probe instead of guessing.
//
// The class is deliberately free of React: it survives re-renders, and
// `hooks/useUploads.ts` binds it with `useSyncExternalStore`.
import type {
  PluginRpcClient,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";

import {
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  TOKEN_URL,
  UPLOAD_CHUNK_URL,
  type FileManagerContract,
} from "../contract";
import { errorToastText, parseRpcError } from "./errors";
import { etaFromRate } from "./format";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Method = Extract<keyof FileManagerContract, string>;
type ContractInput<M extends Method> = StandardSchemaV1InferInput<FileManagerContract[M]["input"]>;
type ContractOutput<M extends Method> = StandardSchemaV1InferOutput<
  FileManagerContract[M]["output"]
>;

/**
 * The four RPC methods the manager needs. Narrow on purpose: tests hand it a
 * plain object, and the panel hands it {@link uploadRpcFromClient}.
 */
export interface UploadRpc {
  uploadCreate(input: ContractInput<"uploadCreate">): Promise<ContractOutput<"uploadCreate">>;
  uploadStatus(input: ContractInput<"uploadStatus">): Promise<ContractOutput<"uploadStatus">>;
  uploadFinish(input: ContractInput<"uploadFinish">): Promise<ContractOutput<"uploadFinish">>;
  uploadAbort(input: ContractInput<"uploadAbort">): Promise<ContractOutput<"uploadAbort">>;
}

/** Adapts the SDK's generic `useRpc()` client to {@link UploadRpc}. */
export function uploadRpcFromClient(
  client: Pick<PluginRpcClient<FileManagerContract>, "call">,
): UploadRpc {
  return {
    uploadCreate: (input) => client.call("uploadCreate", input),
    uploadStatus: (input) => client.call("uploadStatus", input),
    uploadFinish: (input) => client.call("uploadFinish", input),
    uploadAbort: (input) => client.call("uploadAbort", input),
  };
}

export type UploadStatus =
  | "queued"
  | "uploading"
  | "finishing"
  | "done"
  | "error"
  | "canceled"
  /** Not in §8.7's list: added for the tray's pause button. */
  | "paused";

export interface UploadState {
  id: string;
  fileName: string;
  /** Destination directory as it was dropped (absolute or root-relative). */
  dirPath: string;
  /** POSIX sub-path under `dirPath` for folder drops; "" for a plain file. */
  relativeDir: string;
  sizeBytes: number;
  /** Bytes the server has acknowledged, plus the in-flight chunk's progress. */
  sentBytes: number;
  status: UploadStatus;
  bytesPerSecond: number;
  etaMs: number | null;
  errorMessage: string | null;
  /** Absolute path of the committed file, once `uploadFinish` returned. */
  resultPath: string | null;
}

export interface UploadRequest {
  file: File;
  dirPath: string;
  /** POSIX sub-path under `dirPath`, e.g. "photos/2024". Defaults to "". */
  relativeDir?: string;
}

export interface UploadManagerOptions {
  /** The RPC surface, or a getter when the client is only available later. */
  rpc: UploadRpc | (() => UploadRpc);
  /** At most this many files move at once (§5.2: 2). */
  maxConcurrentFiles?: number;
  /** Network/5xx retries per chunk before the file fails (§5.2: 3). */
  maxAttempts?: number;
  /** Seconds a chunk should take; drives adaptive sizing (§5.2: 45). */
  targetChunkSeconds?: number;
  /** Used until `uploadCreate` reports the server's preference. */
  defaultChunkSizeBytes?: number;
  /** Conflict policy handed to `uploadFinish` (§5.2 step 4). */
  conflict?: "rename" | "overwrite" | "fail";
  /**
   * Chunk-size clamp. Defaults to the contract's [4 MiB, 64 MiB]; tests narrow
   * it so a 10-byte fixture can still exercise multi-chunk behaviour.
   */
  minChunkBytes?: number;
  maxChunkBytes?: number;
  /** Test seams. */
  createXhr?: () => XMLHttpRequest;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between progress-driven notifications, in ms. */
  progressIntervalMs?: number;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

const MIB = 1024 * 1024;

class CanceledError extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledError";
  }
}

class ChunkAbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "ChunkAbortedError";
  }
}

class ChunkNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkNetworkError";
  }
}

interface ChunkOutcome {
  status: number;
  body: Record<string, unknown> | null;
}

interface UploadItem {
  state: UploadState;
  file: File;
  uploadId: string | null;
  /** Bytes the server has acknowledged. `state.sentBytes` may run ahead. */
  offset: number;
  chunkSizeBytes: number;
  attempt: number;
  busyAttempts: number;
  /** Guards the single automatic session re-creation after a 404. */
  recreated: boolean;
  /** Guards the single automatic token refresh after a 401 (§5.1). */
  tokenRefreshed: boolean;
  paused: boolean;
  canceled: boolean;
  activeXhr: XMLHttpRequest | null;
  /** Smoothed throughput in bytes/second. */
  rate: number;
}

function isTerminal(status: UploadStatus): boolean {
  return status === "done" || status === "error" || status === "canceled";
}

function parseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function numberField(body: Record<string, unknown> | null, key: string): number | null {
  const value = body?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key];
  return typeof value === "string" ? value : null;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `up_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* The manager                                                         */
/* ------------------------------------------------------------------ */

export class UploadManager {
  private readonly items = new Map<string, UploadItem>();
  private readonly order: string[] = [];
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private readonly listeners = new Set<(state: UploadState[]) => void>();

  private readonly rpcSource: UploadRpc | (() => UploadRpc);
  private readonly maxConcurrentFiles: number;
  private readonly maxAttempts: number;
  private readonly targetChunkSeconds: number;
  private readonly defaultChunkSizeBytes: number;
  private readonly conflict: "rename" | "overwrite" | "fail";
  private readonly minChunkBytes: number;
  private readonly maxChunkBytes: number;
  private readonly createXhr: () => XMLHttpRequest;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly progressIntervalMs: number;

  private tokenPromise: Promise<string> | null = null;
  private snapshot: UploadState[] = [];
  private snapshotDirty = true;
  private lastProgressNotifyAt = 0;
  /** A file that hits 409 upload_busy this often gives up. */
  private readonly maxBusyAttempts = 10;
  private readonly busyDelayMs = 500;

  constructor(options: UploadManagerOptions) {
    this.rpcSource = options.rpc;
    this.maxConcurrentFiles = Math.max(1, options.maxConcurrentFiles ?? 2);
    this.maxAttempts = Math.max(0, options.maxAttempts ?? 3);
    this.targetChunkSeconds = options.targetChunkSeconds ?? 45;
    this.minChunkBytes = Math.max(1, options.minChunkBytes ?? MIN_CHUNK_BYTES);
    this.maxChunkBytes = Math.max(this.minChunkBytes, options.maxChunkBytes ?? MAX_CHUNK_BYTES);
    this.defaultChunkSizeBytes = this.clampChunk(options.defaultChunkSizeBytes ?? 16 * MIB);
    this.conflict = options.conflict ?? "rename";
    this.createXhr = options.createXhr ?? (() => new XMLHttpRequest());
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.progressIntervalMs = options.progressIntervalMs ?? 100;
  }

  /* ---------------- public API (§8.7) ---------------- */

  enqueue(requests: readonly UploadRequest[]): UploadState[] {
    const created: UploadState[] = [];
    for (const request of requests) {
      const id = nextId();
      const item: UploadItem = {
        state: {
          id,
          fileName: request.file.name,
          dirPath: request.dirPath,
          relativeDir: request.relativeDir ?? "",
          sizeBytes: request.file.size,
          sentBytes: 0,
          status: "queued",
          bytesPerSecond: 0,
          etaMs: null,
          errorMessage: null,
          resultPath: null,
        },
        file: request.file,
        uploadId: null,
        offset: 0,
        chunkSizeBytes: this.defaultChunkSizeBytes,
        attempt: 0,
        busyAttempts: 0,
        recreated: false,
        tokenRefreshed: false,
        paused: false,
        canceled: false,
        activeXhr: null,
        rate: 0,
      };
      this.items.set(id, item);
      this.order.push(id);
      this.queue.push(id);
      created.push({ ...item.state });
    }
    this.notify(true);
    this.pump();
    return created;
  }

  cancel(id: string): void {
    const item = this.items.get(id);
    if (item === undefined || isTerminal(item.state.status)) return;
    item.canceled = true;
    item.paused = false;
    this.dropFromQueue(id);
    this.abortActive(item);
    const uploadId = item.uploadId;
    if (uploadId !== null) {
      // Fire and forget: the session is garbage-collected anyway (§5.2).
      void Promise.resolve()
        .then(() => this.rpc().uploadAbort({ uploadId }))
        .catch(() => undefined);
    }
    // Progress runs ahead of the acknowledged offset (the socket accepted
    // bytes the server may never have written); roll it back to the truth.
    item.state.sentBytes = item.offset;
    item.state.bytesPerSecond = 0;
    item.state.etaMs = null;
    this.setStatus(item, "canceled");
  }

  /** Re-queues a failed, canceled or paused upload. Resumes where it stopped. */
  retry(id: string): void {
    const item = this.items.get(id);
    if (item === undefined) return;
    if (
      item.state.status === "uploading" ||
      item.state.status === "finishing" ||
      item.state.status === "done"
    ) {
      return;
    }
    if (item.state.status === "canceled") {
      // The session was aborted server-side; start a fresh one.
      item.uploadId = null;
      item.offset = 0;
      item.state.sentBytes = 0;
    }
    item.canceled = false;
    item.paused = false;
    item.attempt = 0;
    item.busyAttempts = 0;
    item.recreated = false;
    item.tokenRefreshed = false;
    item.state.errorMessage = null;
    this.setStatus(item, "queued");
    if (!this.queue.includes(id)) this.queue.push(id);
    this.pump();
  }

  /**
   * Arrow property, not a method: `useSyncExternalStore` calls it detached, so
   * it must not depend on `this` being bound by the call site.
   */
  subscribe = (listener: (state: UploadState[]) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /* ---------------- extras the tray needs ---------------- */

  pause(id: string): void {
    const item = this.items.get(id);
    if (item === undefined || isTerminal(item.state.status) || item.state.status === "paused") {
      return;
    }
    item.paused = true;
    this.dropFromQueue(id);
    this.abortActive(item);
    item.state.sentBytes = item.offset;
    item.state.bytesPerSecond = 0;
    item.state.etaMs = null;
    this.setStatus(item, "paused");
  }

  resume(id: string): void {
    const item = this.items.get(id);
    if (item === undefined || item.state.status !== "paused") return;
    this.retry(id);
  }

  cancelAll(): void {
    for (const id of [...this.order]) this.cancel(id);
  }

  /** Drops finished/failed/canceled rows from the tray. */
  clearFinished(): void {
    for (const id of [...this.order]) {
      const item = this.items.get(id);
      if (item !== undefined && isTerminal(item.state.status)) this.remove(id);
    }
  }

  remove(id: string): void {
    const item = this.items.get(id);
    if (item === undefined) return;
    if (!isTerminal(item.state.status)) this.cancel(id);
    this.items.delete(id);
    this.dropFromQueue(id);
    const index = this.order.indexOf(id);
    if (index !== -1) this.order.splice(index, 1);
    this.notify(true);
  }

  /** Stable snapshot; re-created only when something actually changed. */
  getState = (): UploadState[] => {
    if (this.snapshotDirty) {
      this.snapshot = this.order
        .map((id) => this.items.get(id))
        .filter((item): item is UploadItem => item !== undefined)
        .map((item) => ({ ...item.state }));
      this.snapshotDirty = false;
    }
    return this.snapshot;
  };

  /** queued + uploading + finishing + paused. */
  getActiveCount(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (!isTerminal(item.state.status)) count += 1;
    }
    return count;
  }

  /* ---------------- queue plumbing ---------------- */

  private rpc(): UploadRpc {
    return typeof this.rpcSource === "function" ? this.rpcSource() : this.rpcSource;
  }

  private dropFromQueue(id: string): void {
    const index = this.queue.indexOf(id);
    if (index !== -1) this.queue.splice(index, 1);
  }

  private abortActive(item: UploadItem): void {
    const xhr = item.activeXhr;
    item.activeXhr = null;
    if (xhr !== null) {
      try {
        xhr.abort();
      } catch {
        /* a fake or already-finished xhr may refuse; the loop still exits */
      }
    }
  }

  private pump(): void {
    while (this.running.size < this.maxConcurrentFiles && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) return;
      const item = this.items.get(id);
      if (item === undefined || item.state.status !== "queued") continue;
      this.running.add(id);
      void this.runItem(item).finally(() => {
        this.running.delete(id);
        this.pump();
      });
    }
  }

  private setStatus(item: UploadItem, status: UploadStatus): void {
    // A canceled item never re-enters another state on its own; only retry()
    // clears the flag.
    if (item.canceled && status !== "canceled" && status !== "queued") return;
    if (item.state.status === status) {
      this.notify(true);
      return;
    }
    item.state.status = status;
    this.notify(true);
  }

  private notify(immediate: boolean): void {
    this.snapshotDirty = true;
    if (!immediate) {
      const now = this.now();
      if (now - this.lastProgressNotifyAt < this.progressIntervalMs) return;
      this.lastProgressNotifyAt = now;
    }
    const state = this.getState();
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch {
        /* a throwing subscriber must not break the queue */
      }
    }
  }

  /* ---------------- token (§5.1) ---------------- */

  private token(force = false): Promise<string> {
    if (force) this.tokenPromise = null;
    this.tokenPromise ??= (async () => {
      const response = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const json: unknown = await response.json().catch(() => null);
      const token =
        typeof json === "object" && json !== null && "token" in json
          ? (json as { token: unknown }).token
          : undefined;
      if (!response.ok || typeof token !== "string" || token === "") {
        throw new Error(`failed to fetch the plugin token (HTTP ${response.status})`);
      }
      return token;
    })();
    // Never cache a rejection.
    this.tokenPromise.catch(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  /* ---------------- the per-file pipeline ---------------- */

  private async runItem(item: UploadItem): Promise<void> {
    try {
      if (item.canceled) {
        this.setStatus(item, "canceled");
        return;
      }
      this.setStatus(item, "uploading");
      await this.ensureSession(item);

      while (item.offset < item.state.sizeBytes) {
        if (item.canceled) throw new CanceledError();
        if (item.paused) {
          item.state.sentBytes = item.offset;
          this.setStatus(item, "paused");
          return;
        }
        await this.uploadOneChunk(item);
      }

      if (item.canceled) throw new CanceledError();
      if (item.paused) {
        this.setStatus(item, "paused");
        return;
      }

      this.setStatus(item, "finishing");
      const uploadId = item.uploadId;
      if (uploadId === null) throw new Error("io_error: the upload session disappeared");
      const finished = await this.rpc().uploadFinish({ uploadId, conflict: this.conflict });
      item.state.sentBytes = item.state.sizeBytes;
      item.state.bytesPerSecond = 0;
      item.state.etaMs = null;
      item.state.resultPath = finished.entry.path;
      this.setStatus(item, "done");
    } catch (error) {
      item.activeXhr = null;
      if (item.canceled || error instanceof CanceledError) {
        item.state.sentBytes = item.offset;
        item.state.bytesPerSecond = 0;
        item.state.etaMs = null;
        item.canceled = true;
        this.setStatus(item, "canceled");
        return;
      }
      if (item.paused) {
        item.state.sentBytes = item.offset;
        this.setStatus(item, "paused");
        return;
      }
      item.state.errorMessage = errorToastText(error, "Upload failed.");
      item.state.sentBytes = item.offset;
      item.state.bytesPerSecond = 0;
      item.state.etaMs = null;
      this.setStatus(item, "error");
    }
  }

  /** `uploadCreate`, which also resumes an interrupted session by its key. */
  private async ensureSession(item: UploadItem): Promise<void> {
    if (item.uploadId !== null) return;
    const lastModified = Number(item.file.lastModified);
    const created = await this.rpc().uploadCreate({
      dirPath: item.state.dirPath,
      fileName: item.state.fileName,
      sizeBytes: item.state.sizeBytes,
      lastModifiedMs: Number.isFinite(lastModified) ? Math.max(0, Math.floor(lastModified)) : 0,
      relativeDir: item.state.relativeDir,
    });
    item.uploadId = created.uploadId;
    item.offset = Math.min(Math.max(0, created.receivedBytes), item.state.sizeBytes);
    item.state.sentBytes = item.offset;
    item.chunkSizeBytes = this.clampChunk(created.chunkSizeBytes);
    this.notify(true);
  }

  private async uploadOneChunk(item: UploadItem): Promise<void> {
    const start = item.offset;
    const end = Math.min(start + item.chunkSizeBytes, item.state.sizeBytes);
    const chunkBytes = end - start;
    const startedAt = this.now();

    let outcome: ChunkOutcome;
    try {
      const token = await this.token();
      if (item.canceled) throw new CanceledError();
      if (item.paused) return;
      outcome = await this.sendChunk(item, token, item.file.slice(start, end));
    } catch (error) {
      if (error instanceof CanceledError || item.canceled) throw new CanceledError();
      if (error instanceof ChunkAbortedError) {
        // pause() and cancel() are the only things that abort the request.
        if (item.paused) return;
        throw new CanceledError();
      }
      // Dropped socket, DNS failure, token endpoint down: back off, re-probe,
      // and let the loop try again from the authoritative offset.
      await this.backoffAndResync(item, error);
      return;
    } finally {
      item.activeXhr = null;
    }

    const { status, body } = outcome;

    if (status === 200) {
      const elapsed = Math.max(0, this.now() - startedAt);
      const received = numberField(body, "received");
      item.offset = received === null ? end : Math.min(Math.max(0, received), item.state.sizeBytes);
      item.state.sentBytes = item.offset;
      item.attempt = 0;
      item.busyAttempts = 0;
      item.tokenRefreshed = false;
      this.recordRate(item, chunkBytes, elapsed);
      this.adaptChunkSize(item);
      this.notify(true);
      return;
    }

    if (status === 401) {
      // The token can be rotated under us; refresh once, then treat it as fatal.
      if (item.tokenRefreshed) {
        throw new Error("The plugin token was rejected. Reload the panel and try again.");
      }
      item.tokenRefreshed = true;
      await this.token(true);
      return;
    }

    if (status === 409) {
      const expected = numberField(body, "expected");
      if (expected !== null) {
        item.offset = Math.min(Math.max(0, expected), item.state.sizeBytes);
        item.state.sentBytes = item.offset;
      }
      if (stringField(body, "error") === "upload_busy") {
        item.busyAttempts += 1;
        if (item.busyAttempts > this.maxBusyAttempts) {
          throw new Error("upload_busy: another chunk of this upload never finished");
        }
        await this.sleep(this.busyDelayMs);
      } else {
        // offset_mismatch is a successful re-sync, not a failure.
        item.attempt = 0;
      }
      this.notify(true);
      return;
    }

    if (status === 404) {
      // The session expired, was aborted, or the server restarted. One free
      // re-create (uploadCreate is idempotent on its session key).
      if (item.recreated) throw new Error("upload_not_found: the upload session expired");
      item.recreated = true;
      item.uploadId = null;
      item.offset = 0;
      item.state.sentBytes = 0;
      await this.ensureSession(item);
      return;
    }

    if (status === 413) {
      throw new Error("size_mismatch: the file changed while it was uploading");
    }

    if (status === 400) {
      throw new Error("The server rejected the chunk request (HTTP 400)");
    }

    if (status === 499) {
      const received = numberField(body, "received");
      if (received !== null) {
        item.offset = Math.min(Math.max(0, received), item.state.sizeBytes);
        item.state.sentBytes = item.offset;
      }
      await this.backoffAndResync(item, new Error("The connection dropped mid-chunk"));
      return;
    }

    const message = stringField(body, "message") ?? stringField(body, "error");
    await this.backoffAndResync(
      item,
      new Error(message ?? `The upload failed (HTTP ${status})`),
    );
  }

  /** One chunk over XHR so `xhr.upload.onprogress` can drive the tray. */
  private sendChunk(item: UploadItem, token: string, blob: Blob): Promise<ChunkOutcome> {
    const url = `${UPLOAD_CHUNK_URL}?uploadId=${encodeURIComponent(
      item.uploadId ?? "",
    )}&offset=${String(item.offset)}`;
    const base = item.offset;
    const chunkBytes = blob.size;

    return new Promise<ChunkOutcome>((resolve, reject) => {
      const xhr = this.createXhr();
      item.activeXhr = xhr;
      xhr.open("POST", url, true);
      try {
        xhr.responseType = "text";
      } catch {
        /* some fakes do not implement responseType */
      }
      xhr.setRequestHeader("x-bb-plugin-token", token);
      // Irrelevant to the token route's auth, but honest about the payload.
      xhr.setRequestHeader("content-type", "application/octet-stream");

      const upload: XMLHttpRequestUpload | undefined = xhr.upload;
      if (upload !== undefined && upload !== null) {
        upload.onprogress = (event: ProgressEvent) => {
          const loaded = Math.min(Math.max(0, event.loaded), chunkBytes);
          item.state.sentBytes = Math.min(base + loaded, item.state.sizeBytes);
          if (item.rate > 0) {
            item.state.etaMs = etaFromRate(
              item.state.sizeBytes - item.state.sentBytes,
              item.rate,
            );
          }
          this.notify(false);
        };
      }

      xhr.onload = () => {
        resolve({ status: xhr.status, body: parseJson(xhr.responseText) });
      };
      xhr.onerror = () => {
        reject(new ChunkNetworkError("network error"));
      };
      xhr.ontimeout = () => {
        reject(new ChunkNetworkError("request timed out"));
      };
      xhr.onabort = () => {
        reject(new ChunkAbortedError());
      };

      xhr.send(blob);
    });
  }

  /**
   * §5.2: retry up to `maxAttempts` with 1 s / 3 s / 9 s backoff, re-probing
   * the staged size with `uploadStatus` so the next chunk starts from the byte
   * the server actually has.
   */
  private async backoffAndResync(item: UploadItem, error: unknown): Promise<void> {
    item.attempt += 1;
    if (item.attempt > this.maxAttempts) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    item.state.bytesPerSecond = 0;
    item.state.etaMs = null;
    this.notify(true);

    await this.sleep(1000 * 3 ** (item.attempt - 1));
    if (item.canceled) throw new CanceledError();
    if (item.paused) return;

    const uploadId = item.uploadId;
    if (uploadId === null) return;
    try {
      const status = await this.rpc().uploadStatus({ uploadId });
      item.offset = Math.min(Math.max(0, status.receivedBytes), item.state.sizeBytes);
      item.state.sentBytes = item.offset;
    } catch (probeError) {
      if (parseRpcError(probeError).code === "upload_not_found") {
        item.uploadId = null;
        item.offset = 0;
        item.state.sentBytes = 0;
        await this.ensureSession(item);
      }
      // Any other probe failure: keep the local offset. The next chunk either
      // works or comes back as 409 with the authoritative `expected`.
    }
    this.notify(true);
  }

  private recordRate(item: UploadItem, bytes: number, elapsedMs: number): void {
    if (elapsedMs <= 0 || bytes <= 0) return;
    const observed = (bytes / elapsedMs) * 1000;
    item.rate = item.rate === 0 ? observed : item.rate * 0.6 + observed * 0.4;
    item.state.bytesPerSecond = Math.round(item.rate);
    item.state.etaMs = etaFromRate(item.state.sizeBytes - item.state.sentBytes, item.rate);
  }

  private clampChunk(bytes: number): number {
    if (!Number.isFinite(bytes) || bytes <= 0) return this.minChunkBytes;
    return Math.min(this.maxChunkBytes, Math.max(this.minChunkBytes, Math.round(bytes)));
  }

  /** `clamp(observedBytesPerSecond * 45s, 4 MiB, 64 MiB)`, rounded to a MiB. */
  private adaptChunkSize(item: UploadItem): void {
    if (item.rate <= 0) return;
    const granularity = Math.min(MIB, this.minChunkBytes);
    const target = item.rate * this.targetChunkSeconds;
    const rounded = Math.max(granularity, Math.round(target / granularity) * granularity);
    item.chunkSizeBytes = this.clampChunk(rounded);
  }
}
