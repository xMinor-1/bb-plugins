import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import host from "../host";

it("captures an HTML drawing as a PNG on the document's host", async () => {
  const temp = path.resolve("../../../../.tmp/doc-review-dev/drawing-capture-check");
  await mkdir(temp, { recursive: true });
  const encoded = await host.handlers.drawing({
    html: '<!doctype html><html><body style="margin:0;background:white"><h1 style="padding:40px">Doc Review drawing</h1><div style="margin:40px;background:#dbeafe;width:300px;height:100px">Image area</div></body></html>',
    label: "Комментарий №11 · index.html", folder: temp, viewport: { w: 640, h: 360 }, scroll: { x: 0, y: 0 },
    strokes: [{ tool: "pen", points: [30, 120, 350, 120, 350, 270, 30, 270, 30, 120] }],
  }, { experimental_paths: { tempDir: temp } } as any);
  const bytes = Buffer.from(encoded, "base64");
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.readUInt32BE(16)).toBe(640);
  expect(bytes.readUInt32BE(20)).toBe(404);
  await writeFile(path.join(temp, "drawing-check.png"), bytes);
  const pngCapture = await host.handlers.drawing({
    label: "Комментарий №12 · pages.pdf", folder: temp,
    html: `<html><body style="margin:0"><img src="data:image/png;base64,${encoded}"></body></html>`,
    viewport: { w: 640, h: 404 }, scroll: { x: 0, y: 0 }, strokes: [],
  }, { experimental_paths: { tempDir: temp } } as any);
  expect(Buffer.from(pngCapture, "base64").readUInt32BE(20)).toBe(448);
}, 30000);

it("subscribes once, emits invalidation and releases native watchers", async () => {
  const temp = path.resolve("../../../../.tmp");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(path.join(temp, "doc-review-watch-"));
  const file = path.join(root, "doc.html");
  await writeFile(file, "test");
  const dispose = vi.fn(async () => {});
  const watch = vi.fn(async (_options: unknown, _listener: (event: any) => Promise<void>) => ({ dispose }));
  const emit = vi.fn(async () => {});
  const lifecycle = new AbortController();
  const context = { experimental_watch: watch, experimental_emitSignal: emit, lifecycle: { signal: lifecycle.signal } } as any;
  try {
    const a = await host.handlers.fileVersion({ path: file }, context);
    const b = await host.handlers.fileVersion({ path: file }, context);
    expect(a).toBe(b);
    expect(watch).toHaveBeenCalledTimes(1);
    await watch.mock.calls[0][1]({ kind: "changed", changes: [{ path: "other.html", type: "update" }] });
    expect(emit).not.toHaveBeenCalled();
    await watch.mock.calls[0][1]({ kind: "changed", changes: [{ path: "doc.html", type: "update" }] });
    expect(emit).toHaveBeenCalledWith("changed", { path: file });
    await watch.mock.calls[0][1]({ kind: "changed", changes: [{ path: file, type: "delete" }] });
    await watch.mock.calls[0][1]({ kind: "changed", changes: [{ path: root, type: "delete" }] });
    await watch.mock.calls[0][1]({ kind: "rescan-required" });
    expect(emit).toHaveBeenCalledTimes(4);
    await watch.mock.calls[0][1]({ kind: "watch-error", message: "Native watcher failed" });
    expect(dispose).toHaveBeenCalledTimes(1);
    await host.handlers.fileVersion({ path: file }, context);
    expect(watch).toHaveBeenCalledTimes(2);
  } finally {
    lifecycle.abort();
    await host.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
  expect(dispose).toHaveBeenCalledTimes(2);
});
