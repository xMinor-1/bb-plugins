// @vitest-environment jsdom
//
// The upload manager against a faked network. The fake implements the *server*
// contract of §5.2 (offset checks, 409 `expected`, 499 `received`, 413, 401)
// rather than a canned script, so a test that passes here is a test the real
// backend would also satisfy.
import { describe, expect, it } from "vitest";

import { TOKEN_URL, UPLOAD_CHUNK_URL, type FileEntry } from "../../contract";
import { UploadManager, type UploadRpc, type UploadState } from "../../lib/upload-manager";

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

interface ChunkCall {
  path: string;
  uploadId: string;
  offset: number;
  text: string;
  token: string;
}

type ChunkReply =
  | { kind: "http"; status: number; body: unknown }
  | { kind: "network" };

interface Session {
  uploadId: string;
  dirPath: string;
  relativeDir: string;
  fileName: string;
  sizeBytes: number;
  lastModifiedMs: number;
  staged: string;
}

function entryFor(path: string, sizeBytes: number): FileEntry {
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    kind: "file",
    targetKind: null,
    sizeBytes,
    modifiedAtMs: 1,
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
  };
}

class FakeServer {
  token = "token-1";
  tokenRequests = 0;
  tokenFailures = 0;
  chunkSizeBytes = 4;
  clock = 0;
  chunkDurationMs = 1000;

  readonly sessions = new Map<string, Session>();
  readonly committed = new Map<string, string>();
  readonly chunkCalls: ChunkCall[] = [];
  readonly rpcCalls: string[] = [];

  /** One-shot chunk interceptors, consumed in order. Return null to fall through. */
  private readonly chunkScript: Array<(call: ChunkCall, session: Session | undefined) => ChunkReply | null> = [];
  /** One-shot `uploadStatus` interceptors. */
  private readonly statusScript: Array<(session: Session) => number | null> = [];

  private hold: { promise: Promise<void>; release: () => void; fromIndex: number } | null = null;
  private inFlight = 0;
  maxInFlight = 0;
  private nextSession = 0;

  scriptChunk(fn: (call: ChunkCall, session: Session | undefined) => ChunkReply | null): void {
    this.chunkScript.push(fn);
  }

  scriptStatus(fn: (session: Session) => number | null): void {
    this.statusScript.push(fn);
  }

  /** Blocks every chunk call from `fromIndex` on until the returned fn is called. */
  holdChunks(fromIndex = 0): () => void {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    this.hold = { promise, release, fromIndex };
    return () => {
      this.hold?.release();
      this.hold = null;
    };
  }

  async handleChunk(call: ChunkCall): Promise<ChunkReply> {
    this.chunkCalls.push(call);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.hold !== null && this.chunkCalls.length - 1 >= this.hold.fromIndex) {
        await this.hold.promise;
      }
      this.clock += this.chunkDurationMs;

      const session = this.sessions.get(call.uploadId);
      const scripted = this.chunkScript.shift();
      if (scripted !== undefined) {
        const reply = scripted(call, session);
        if (reply !== null) return reply;
      }

      // The host rejects a bad token before the handler ever runs.
      if (call.token !== this.token) {
        return { kind: "http", status: 401, body: { ok: false, error: "unauthorized" } };
      }
      if (session === undefined) {
        return { kind: "http", status: 404, body: { ok: false, error: "upload_not_found" } };
      }
      if (call.offset !== session.staged.length) {
        return {
          kind: "http",
          status: 409,
          body: { ok: false, error: "offset_mismatch", expected: session.staged.length },
        };
      }
      if (call.offset + call.text.length > session.sizeBytes) {
        return { kind: "http", status: 413, body: { ok: false, error: "size_mismatch" } };
      }
      session.staged += call.text;
      return {
        kind: "http",
        status: 200,
        body: { ok: true, uploadId: session.uploadId, received: session.staged.length },
      };
    } finally {
      this.inFlight -= 1;
    }
  }

  readonly rpc: UploadRpc = {
    uploadCreate: async (input) => {
      this.rpcCalls.push("uploadCreate");
      const relativeDir = input.relativeDir ?? "";
      const lastModifiedMs = input.lastModifiedMs ?? 0;
      for (const session of this.sessions.values()) {
        if (
          session.dirPath === input.dirPath &&
          session.relativeDir === relativeDir &&
          session.fileName === input.fileName &&
          session.sizeBytes === input.sizeBytes &&
          session.lastModifiedMs === lastModifiedMs
        ) {
          return {
            uploadId: session.uploadId,
            receivedBytes: session.staged.length,
            chunkSizeBytes: this.chunkSizeBytes,
            resumed: true,
          };
        }
      }
      this.nextSession += 1;
      const uploadId = `${this.nextSession}`.padStart(32, "0");
      this.sessions.set(uploadId, {
        uploadId,
        dirPath: input.dirPath,
        relativeDir,
        fileName: input.fileName,
        sizeBytes: input.sizeBytes,
        lastModifiedMs,
        staged: "",
      });
      return {
        uploadId,
        receivedBytes: 0,
        chunkSizeBytes: this.chunkSizeBytes,
        resumed: false,
      };
    },

    uploadStatus: async ({ uploadId }) => {
      this.rpcCalls.push("uploadStatus");
      const session = this.sessions.get(uploadId);
      if (session === undefined) throw new Error(`upload_not_found: ${uploadId}`);
      const scripted = this.statusScript.shift();
      const receivedBytes = scripted === undefined ? null : scripted(session);
      return {
        uploadId,
        receivedBytes: receivedBytes ?? session.staged.length,
        sizeBytes: session.sizeBytes,
        dirPath: session.dirPath,
        fileName: session.fileName,
      };
    },

    uploadFinish: async ({ uploadId }) => {
      this.rpcCalls.push("uploadFinish");
      const session = this.sessions.get(uploadId);
      if (session === undefined) throw new Error(`upload_not_found: ${uploadId}`);
      const target = [session.dirPath, session.relativeDir, session.fileName]
        .filter((part) => part !== "")
        .join("/");
      this.committed.set(target, session.staged);
      this.sessions.delete(uploadId);
      return { entry: entryFor(target, session.staged.length) };
    },

    uploadAbort: async ({ uploadId }) => {
      this.rpcCalls.push("uploadAbort");
      this.sessions.delete(uploadId);
      return { ok: true as const };
    },
  };

  createXhr(): XMLHttpRequest {
    return new FakeXhr(this) as unknown as XMLHttpRequest;
  }

  fetchImpl(): typeof fetch {
    return (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url !== TOKEN_URL) throw new Error(`unexpected fetch: ${url}`);
      this.tokenRequests += 1;
      if (this.tokenFailures > 0) {
        this.tokenFailures -= 1;
        return {
          ok: false,
          status: 500,
          json: async () => ({ ok: false }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, token: this.token }),
      } as unknown as Response;
    }) as typeof fetch;
  }
}

class FakeXhr {
  status = 0;
  responseText = "";
  responseType = "";
  readonly upload = {
    onprogress: null as
      | ((event: { loaded: number; total: number; lengthComputable: boolean }) => void)
      | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  private url = "";
  private readonly headers = new Map<string, string>();
  private aborted = false;
  private settled = false;

  constructor(private readonly server: FakeServer) {}

  open(_method: string, url: string): void {
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: Blob): void {
    void this.run(body);
  }

  abort(): void {
    if (this.settled) return;
    this.settled = true;
    this.aborted = true;
    this.onabort?.();
  }

  private async run(body: Blob): Promise<void> {
    const text = await body.text();
    if (this.aborted) return;
    const [path = "", query = ""] = this.url.split("?");
    const params = new URLSearchParams(query);
    this.upload.onprogress?.({ loaded: body.size, total: body.size, lengthComputable: true });
    const reply = await this.server.handleChunk({
      path,
      uploadId: params.get("uploadId") ?? "",
      offset: Number(params.get("offset") ?? "0"),
      text,
      token: this.headers.get("x-bb-plugin-token") ?? "",
    });
    if (this.aborted || this.settled) return;
    this.settled = true;
    if (reply.kind === "network") {
      this.onerror?.();
      return;
    }
    this.status = reply.status;
    this.responseText = JSON.stringify(reply.body);
    this.onload?.();
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const DIR = "/home/coder/uploads";

function makeFile(name: string, content: string, lastModified = 1_700_000_000_000): File {
  return new File([content], name, { lastModified });
}

function createManager(
  server: FakeServer,
  overrides: Partial<ConstructorParameters<typeof UploadManager>[0]> = {},
): UploadManager {
  return new UploadManager({
    rpc: server.rpc,
    createXhr: () => server.createXhr(),
    fetchImpl: server.fetchImpl(),
    now: () => server.clock,
    // Backoff without real waiting; the clock still moves so throttles behave.
    sleep: async (ms: number) => {
      server.clock += ms;
    },
    minChunkBytes: 4,
    maxChunkBytes: 4,
    defaultChunkSizeBytes: 4,
    progressIntervalMs: 0,
    ...overrides,
  });
}

async function until(check: () => boolean, label = "condition", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function stateOf(manager: UploadManager, id: string): UploadState {
  const found = manager.getState().find((upload) => upload.id === id);
  if (found === undefined) throw new Error(`no upload ${id}`);
  return found;
}

async function untilStatus(
  manager: UploadManager,
  id: string,
  status: UploadState["status"],
): Promise<UploadState> {
  await until(() => stateOf(manager, id).status === status, `${id} → ${status}`);
  return stateOf(manager, id);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("happy path", () => {
  it("posts sequential chunks to the token route and commits the exact bytes", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);
    expect(created?.status).toBe("queued");
    const id = created?.id ?? "";

    const final = await untilStatus(manager, id, "done");

    expect(server.committed.get(`${DIR}/a.txt`)).toBe("0123456789");
    expect(server.chunkCalls.map((call) => [call.offset, call.text])).toEqual([
      [0, "0123"],
      [4, "4567"],
      [8, "89"],
    ]);
    expect(server.chunkCalls.every((call) => call.path === UPLOAD_CHUNK_URL)).toBe(true);
    expect(server.chunkCalls.every((call) => call.token === "token-1")).toBe(true);
    expect(server.rpcCalls).toEqual([
      "uploadCreate",
      "uploadFinish",
    ]);
    expect(final.sentBytes).toBe(10);
    expect(final.sizeBytes).toBe(10);
    expect(final.resultPath).toBe(`${DIR}/a.txt`);
    expect(final.errorMessage).toBeNull();
    expect(server.tokenRequests).toBe(1);
  });

  it("fetches the plugin token once for the whole session", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    const ids = manager
      .enqueue([
        { file: makeFile("a.txt", "aaaa"), dirPath: DIR },
        { file: makeFile("b.txt", "bbbbbbbb"), dirPath: DIR, relativeDir: "sub" },
      ])
      .map((upload) => upload.id);

    for (const id of ids) await untilStatus(manager, id, "done");

    expect(server.tokenRequests).toBe(1);
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("aaaa");
    expect(server.committed.get(`${DIR}/sub/b.txt`)).toBe("bbbbbbbb");
  });

  it("uploads a zero-byte file with no chunk requests at all", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    const [created] = manager.enqueue([{ file: makeFile("empty.txt", ""), dirPath: DIR }]);

    await untilStatus(manager, created?.id ?? "", "done");

    expect(server.chunkCalls).toHaveLength(0);
    expect(server.rpcCalls).toEqual(["uploadCreate", "uploadFinish"]);
    expect(server.committed.get(`${DIR}/empty.txt`)).toBe("");
  });

  it("starts from the byte count a resumed session reports", async () => {
    const server = new FakeServer();
    // A session left over from a previous page load, 4 bytes in.
    server.sessions.set("0".repeat(32), {
      uploadId: "0".repeat(32),
      dirPath: DIR,
      relativeDir: "",
      fileName: "a.txt",
      sizeBytes: 10,
      lastModifiedMs: 1_700_000_000_000,
      staged: "0123",
    });
    const manager = createManager(server);
    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);

    await untilStatus(manager, created?.id ?? "", "done");

    expect(server.chunkCalls.map((call) => call.offset)).toEqual([4, 8]);
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("0123456789");
  });
});

describe("failure recovery", () => {
  it("resumes after the connection drops mid-upload", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    // The second chunk never reaches the server.
    let dropped = 0;
    server.scriptChunk(() => null); // chunk 1 behaves normally
    server.scriptChunk(() => {
      dropped += 1;
      return { kind: "network" };
    });

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);
    const final = await untilStatus(manager, created?.id ?? "", "done");

    expect(dropped).toBe(1);
    // It re-probed the authoritative offset before retrying.
    expect(server.rpcCalls).toContain("uploadStatus");
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("0123456789");
    expect(final.sentBytes).toBe(10);
    // 4 posts: 0, 4 (lost), 4 (retried), 8.
    expect(server.chunkCalls.map((call) => call.offset)).toEqual([0, 4, 4, 8]);
  });

  it("re-syncs from `expected` on 409 offset_mismatch without duplicating bytes", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    // The first chunk lands on disk but its response is lost, and the status
    // probe answers with a stale count — the classic way a client ends up
    // posting at the wrong offset.
    server.scriptChunk((call, session) => {
      if (session !== undefined) session.staged += call.text;
      return { kind: "network" };
    });
    server.scriptStatus(() => 0);

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);
    await untilStatus(manager, created?.id ?? "", "done");

    // offset 0 (lost), offset 0 again → 409 expected 4, then 4 and 8.
    expect(server.chunkCalls.map((call) => call.offset)).toEqual([0, 0, 4, 8]);
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("0123456789");
  });

  it("resumes from `received` when the server reports 499 aborted mid-chunk", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    // Half the chunk was written before the socket died.
    server.scriptChunk((call, session) => {
      if (session === undefined) return null;
      session.staged += call.text.slice(0, 2);
      return {
        kind: "http",
        status: 499,
        body: { ok: false, error: "aborted", received: session.staged.length },
      };
    });

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);
    await untilStatus(manager, created?.id ?? "", "done");

    expect(server.chunkCalls.map((call) => [call.offset, call.text])).toEqual([
      [0, "0123"],
      [2, "2345"],
      [6, "6789"],
    ]);
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("0123456789");
  });

  it("waits out a 409 upload_busy and continues from `expected`", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    server.scriptChunk(() => ({
      kind: "http",
      status: 409,
      body: { ok: false, error: "upload_busy", expected: 0 },
    }));

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "01234567"), dirPath: DIR }]);
    await untilStatus(manager, created?.id ?? "", "done");

    expect(server.chunkCalls.map((call) => call.offset)).toEqual([0, 0, 4]);
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("01234567");
  });

  it("re-fetches the token exactly once on a 401 and finishes", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    // The token is rotated between the panel's fetch and the first chunk.
    server.scriptChunk(() => {
      server.token = "token-2";
      return { kind: "http", status: 401, body: { ok: false } };
    });

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "01234567"), dirPath: DIR }]);
    await untilStatus(manager, created?.id ?? "", "done");

    expect(server.tokenRequests).toBe(2);
    expect(server.chunkCalls.map((call) => call.token)).toEqual([
      "token-1",
      "token-2",
      "token-2",
    ]);
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("01234567");
  });

  it("recreates the session once when the server forgot it (404)", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    server.scriptChunk((call) => {
      server.sessions.delete(call.uploadId);
      return { kind: "http", status: 404, body: { ok: false, error: "upload_not_found" } };
    });

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "01234567"), dirPath: DIR }]);
    await untilStatus(manager, created?.id ?? "", "done");

    expect(server.rpcCalls.filter((call) => call === "uploadCreate")).toHaveLength(2);
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("01234567");
  });

  it("fails the file on 413 size_mismatch instead of retrying forever", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    server.scriptChunk(() => ({
      kind: "http",
      status: 413,
      body: { ok: false, error: "size_mismatch" },
    }));

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "01234567"), dirPath: DIR }]);
    const failed = await untilStatus(manager, created?.id ?? "", "error");

    expect(failed.errorMessage).toBe("The file changed while it was uploading.");
    expect(server.rpcCalls).not.toContain("uploadFinish");
    expect(server.chunkCalls).toHaveLength(1);
  });

  it("gives up after the retry budget and can be retried by hand", async () => {
    const server = new FakeServer();
    const manager = createManager(server, { maxAttempts: 2 });
    for (let index = 0; index < 3; index += 1) server.scriptChunk(() => ({ kind: "network" }));

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "01234567"), dirPath: DIR }]);
    const id = created?.id ?? "";
    const failed = await untilStatus(manager, id, "error");
    expect(failed.errorMessage).not.toBeNull();
    expect(server.chunkCalls).toHaveLength(3);

    manager.retry(id);
    await untilStatus(manager, id, "done");
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("01234567");
  });
});

describe("queue control", () => {
  it("cancels a queued upload without touching the network", async () => {
    const server = new FakeServer();
    const manager = createManager(server, { maxConcurrentFiles: 1 });
    const release = server.holdChunks();
    const ids = manager
      .enqueue([
        { file: makeFile("a.txt", "aaaa"), dirPath: DIR },
        { file: makeFile("b.txt", "bbbb"), dirPath: DIR },
      ])
      .map((upload) => upload.id);

    await until(() => server.chunkCalls.length === 1, "first chunk in flight");
    expect(stateOf(manager, ids[1] ?? "").status).toBe("queued");

    manager.cancel(ids[1] ?? "");
    expect(stateOf(manager, ids[1] ?? "").status).toBe("canceled");

    release();
    await untilStatus(manager, ids[0] ?? "", "done");
    expect(server.committed.has(`${DIR}/b.txt`)).toBe(false);
  });

  it("aborts the in-flight request and the server session on cancel", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    const release = server.holdChunks();
    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);
    const id = created?.id ?? "";

    await until(() => server.chunkCalls.length === 1, "chunk in flight");
    manager.cancel(id);

    await untilStatus(manager, id, "canceled");
    await until(() => server.rpcCalls.includes("uploadAbort"), "uploadAbort");
    release();

    expect(server.rpcCalls).not.toContain("uploadFinish");
    expect(server.committed.has(`${DIR}/a.txt`)).toBe(false);
  });

  it("pauses mid-upload, keeps the confirmed offset, and resumes", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    const release = server.holdChunks(1);
    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);
    const id = created?.id ?? "";

    // The first chunk lands; the second is held open, then paused under it.
    await until(() => server.chunkCalls.length >= 2, "second chunk in flight");
    manager.pause(id);

    const paused = await untilStatus(manager, id, "paused");
    expect(paused.sentBytes).toBe(4);
    // The abandoned request still lands server-side, so resuming has to
    // re-sync through a 409 — exactly what happens on a real socket abort.
    release();

    manager.resume(id);
    await untilStatus(manager, id, "done");
    expect(server.committed.get(`${DIR}/a.txt`)).toBe("0123456789");
  });

  it("runs at most two files at a time", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    const release = server.holdChunks();
    const ids = manager
      .enqueue([
        { file: makeFile("a.txt", "aaaa"), dirPath: DIR },
        { file: makeFile("b.txt", "bbbb"), dirPath: DIR },
        { file: makeFile("c.txt", "cccc"), dirPath: DIR },
      ])
      .map((upload) => upload.id);

    await until(() => server.chunkCalls.length === 2, "two chunks in flight");
    const statuses = ids.map((id) => stateOf(manager, id).status);
    expect(statuses.filter((status) => status === "uploading")).toHaveLength(2);
    expect(statuses.filter((status) => status === "queued")).toHaveLength(1);

    release();
    for (const id of ids) await untilStatus(manager, id, "done");
    expect(server.maxInFlight).toBeLessThanOrEqual(2);
    expect(manager.getActiveCount()).toBe(0);
  });

  it("clears finished rows out of the tray", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    const [created] = manager.enqueue([{ file: makeFile("a.txt", "aaaa"), dirPath: DIR }]);
    await untilStatus(manager, created?.id ?? "", "done");

    manager.clearFinished();
    expect(manager.getState()).toHaveLength(0);
  });
});

describe("progress reporting", () => {
  it("notifies subscribers and keeps the snapshot stable between changes", async () => {
    const server = new FakeServer();
    const manager = createManager(server);
    const seen: UploadState[][] = [];
    const unsubscribe = manager.subscribe((state) => seen.push(state));

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);
    await untilStatus(manager, created?.id ?? "", "done");
    unsubscribe();

    expect(seen.length).toBeGreaterThan(3);
    expect(manager.getState()).toBe(manager.getState());
    const progressed = seen.some((state) => {
      const first = state[0];
      return first !== undefined && first.sentBytes > 0 && first.sentBytes < 10;
    });
    expect(progressed).toBe(true);

    const done = stateOf(manager, created?.id ?? "");
    expect(done.bytesPerSecond).toBe(0);
    expect(done.etaMs).toBeNull();
  });

  it("reports a throughput and an eta while bytes are moving", async () => {
    const server = new FakeServer();
    server.chunkDurationMs = 1000;
    const manager = createManager(server);
    const rates: number[] = [];
    const unsubscribe = manager.subscribe((state) => {
      const first = state[0];
      if (first !== undefined && first.status === "uploading" && first.bytesPerSecond > 0) {
        rates.push(first.bytesPerSecond);
      }
    });

    const [created] = manager.enqueue([{ file: makeFile("a.txt", "0123456789"), dirPath: DIR }]);
    await untilStatus(manager, created?.id ?? "", "done");
    unsubscribe();

    // 4 bytes per simulated second.
    expect(rates[0]).toBe(4);
    expect(rates.length).toBeGreaterThan(0);
  });

  it("grows the chunk size toward the 45 s target and clamps at the maximum", async () => {
    const server = new FakeServer();
    server.chunkDurationMs = 1000;
    const manager = createManager(server, { minChunkBytes: 4, maxChunkBytes: 16 });
    const [created] = manager.enqueue([
      { file: makeFile("a.txt", "0".repeat(40)), dirPath: DIR },
    ]);
    await untilStatus(manager, created?.id ?? "", "done");

    const lengths = server.chunkCalls.map((call) => call.text.length);
    // First chunk uses the server's 4-byte preference; 4 B/s * 45 s = 180 B,
    // which clamps to the 16-byte ceiling for every chunk after that.
    expect(lengths[0]).toBe(4);
    expect(lengths.slice(1, -1).every((length) => length === 16)).toBe(true);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(40);
  });
});
