import Database from "better-sqlite3";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import plugin from "../server";

it("sends readable text and agent-only context to current and new threads", async () => {
  const db = new Database(":memory:");
  const dispose: Array<() => void> = [];
  let handlers: any;
  const send = vi.fn(async (_args: any) => ({}));
  const spawn = vi.fn(async (_args: any) => ({ id: "new-thread" }));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII=";
  const upload = vi.fn(async () => ({ path: "/attachments/drawing.png" }));
  const hostCall = vi.fn(async (method: string) => method === "drawing" ? png : "v1");
  const bb = {
    pluginId: "doc-review", onDispose: (fn: () => void) => dispose.push(fn),
    storage: { database: () => ({ name: path.resolve("../../../../.tmp/doc-review-dev/handoff-test.db"), prepare: db.prepare.bind(db), transaction: db.transaction.bind(db) }), migrate: (_db: unknown, statements: string[]) => statements.forEach((s) => db.exec(s)) },
    settings: { define: () => ({ get: async () => ({ rememberRecents: false }) }) },
    hosts: { experimental_client: () => ({ call: hostCall, experimental_onSignal: () => vi.fn(), experimental_onWorkerExit: () => vi.fn() }) },
    sdk: { subscribe: () => vi.fn(), system: { config: async () => ({ primaryHostId: "server" }) }, hosts: { get: async () => ({ status: "connected" }) },
      projects: { attachments: { upload } }, threads: { get: async () => ({ projectId: "project" }), send, spawn } },
    realtime: { publish: vi.fn() }, http: { route: vi.fn() }, cli: { register: vi.fn() },
    rpc: { register: (_contract: unknown, registered: any) => { handlers = registered; } },
  } as unknown as BbPluginApi;
  try {
    await plugin(bb);
    const { doc } = await handlers["doc.open"]({ path: "/reports/audit.html", source: { kind: "host", experimental_hostId: "remote" } });
    for (const target of [{ kind: "thread", threadId: "current-thread" }, { kind: "new-thread", projectId: "project" }]) {
      const comment = await handlers["comments.create"]({ docId: doc.id, anchor: { kind: "html-text", quote: "Evidence", prefix: "", suffix: "", selector: "#evidence" }, body: "Вынести в docs?", docVersion: "v1" });
      expect((await handlers["comments.handoffPrompt"]({ docId: doc.id, ids: [comment.id] })).prompt).toContain("bb doc-review resolve");
      expect((await handlers["comments.send"]({ docId: doc.id, ids: [comment.id], target })).sent).toBe(1);
      const args = target.kind === "thread" ? send.mock.calls[0]![0] : spawn.mock.calls[0]![0];
      expect(args.input[0].text).toContain("Комментарии к audit.html · 1");
      expect(args.input[0].text).toContain("Вынести в docs?");
      expect(args.input[0].text).not.toContain("#evidence");
      expect(args.input[1]).toMatchObject({ visibility: "agent-only", type: "text" });
      expect(args.input[1].text).toContain(comment.id);
      expect(args.input[1].text).toContain("#evidence");
      expect(args.input[1].text).toContain("bb doc-review resolve");
    }
    expect(send.mock.calls[0]![0].mode).toBe("queue-if-active");
    for (const mode of ["steer-if-active", "queue-if-active"] as const) {
      const comment = await handlers["comments.create"]({ docId: doc.id, anchor: { kind: "doc" }, body: mode, docVersion: "v1" });
      await handlers["comments.send"]({ docId: doc.id, ids: [comment.id], target: { kind: "thread", threadId: "current-thread", mode } });
      expect(send.mock.calls.at(-1)![0].mode).toBe(mode);
    }
    const anchor = { kind: "html-drawing", viewport: { w: 640, h: 360 }, strokes: [{ tool: "pen", points: [0, 0, 100, 100] }], marks: [] };
    const capture = { kind: "html", html: "<html><body>Drawing</body></html>", scroll: { x: 0, y: 0 } };
    await expect(handlers["comments.create"]({ docId: doc.id, anchor, body: "Draw", docVersion: "v1" })).rejects.toThrow("capture is missing");
    const drawing = await handlers["comments.create"]({ docId: doc.id, anchor, capture, body: "Draw", docVersion: "v1" });
    expect(hostCall).toHaveBeenCalledWith("drawing", expect.objectContaining({ folder: "/reports", html: capture.html }), { hostId: "remote" });
    await handlers["comments.send"]({ docId: doc.id, ids: [drawing.id], target: { kind: "thread", threadId: "current-thread" } });
    expect(send.mock.calls.at(-1)![0].input[2]).toEqual({ type: "localImage", path: "/attachments/drawing.png" });
    expect(upload).toHaveBeenCalled();
    upload.mockRejectedValueOnce(new Error("Upload failed"));
    await expect(handlers["comments.send"]({ docId: doc.id, ids: [drawing.id], target: { kind: "thread", threadId: "current-thread" } })).rejects.toThrow("Could not attach the drawing");
  } finally {
    dispose.forEach((stop) => stop());
    db.close();
  }
});
