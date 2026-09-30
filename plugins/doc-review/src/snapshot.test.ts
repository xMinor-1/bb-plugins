import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChrome, PageCamera, prepareShotHtml, shotRequestAllowed } from "./snapshot";

describe("prepareShotHtml", () => {
  it("points the review base at the file's folder", () => {
    const html = '<html><head><base data-doc-review-base href="/preview/abc/"><link rel="stylesheet" href="a.css"></head></html>';
    expect(prepareShotHtml(html, "/home/me/site")).toBe(
      '<html><head><base href="file:///home/me/site/"><link rel="stylesheet" href="a.css"></head></html>',
    );
  });

  it("adds a base when the page had its own absolute one or none", () => {
    expect(prepareShotHtml("<html><head><title>x</title></head></html>", "/srv/p")).toBe(
      '<html><head><base href="file:///srv/p/"><title>x</title></head></html>',
    );
  });

  it("drops the review base without a local folder, and refreshes that navigate", () => {
    const html = '<head><base data-doc-review-base href="/p/"><meta http-equiv="refresh" content="0;url=file:///etc/passwd"></head>';
    expect(prepareShotHtml(html, null)).toBe("<head></head>");
  });
});

describe("shotRequestAllowed", () => {
  const page = "file:///data/shots/shot-1.html";
  it("lets the page, its folder, the web, and inline data through", () => {
    expect(shotRequestAllowed(page, page, "/home/me/site")).toBe(true);
    expect(shotRequestAllowed("file:///home/me/site/img/logo.png", page, "/home/me/site")).toBe(true);
    expect(shotRequestAllowed("https://cdn.example.com/a.css", page, "/home/me/site")).toBe(true);
    expect(shotRequestAllowed("data:image/png;base64,AAAA", page, "/home/me/site")).toBe(true);
  });

  it("keeps other files on the machine out", () => {
    expect(shotRequestAllowed("file:///etc/passwd", page, "/home/me/site")).toBe(false);
    expect(shotRequestAllowed("file:///home/me/site-secrets/key", page, "/home/me/site")).toBe(false);
    expect(shotRequestAllowed("file:///home/me/site/../.ssh/id_rsa", page, "/home/me/site")).toBe(false);
    expect(shotRequestAllowed("file:///home/me/site/a.png", page, null)).toBe(false);
  });
});

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const chrome = await findChrome("");

describe.skipIf(!chrome)("PageCamera with Chrome", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "doc-review-shot-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("photographs the viewport where the user was", async () => {
    const camera = new PageCamera(async () => chrome, path.join(dir, "work"));
    await writeFile(path.join(dir, "style.css"), "body{margin:0;background:#eef}");
    const shot = await camera.shoot({
      html: '<!DOCTYPE html><html><head><base data-doc-review-base href="/x/"><link rel="stylesheet" href="style.css"></head><body><div style="height:3000px">Page</div></body></html>',
      folder: dir,
      viewport: { w: 800, h: 600 },
      scroll: { x: 0, y: 1000 },
      strokes: [{ tool: "arrow", points: [100, 1100, 300, 1200] }],
    });
    expect(shot).not.toBeNull();
    expect(pngSize(shot!)).toEqual({ width: 800, height: 600 });
  }, 30_000);

  it("takes in a drawing taller than the view, and phones at twice the pixels", async () => {
    const camera = new PageCamera(async () => chrome, path.join(dir, "work"));
    const shot = await camera.shoot({
      html: '<!DOCTYPE html><html><body style="margin:0"><div style="height:3000px"></div></body></html>',
      folder: dir,
      viewport: { w: 390, h: 700 },
      scroll: { x: 0, y: 0 },
      strokes: [{ tool: "pen", points: [20, 100, 40, 1100] }],
    });
    expect(pngSize(shot!)).toEqual({ width: 780, height: 2 * (1000 + 64) });
  }, 30_000);

  it("gives up quietly without a browser", async () => {
    const camera = new PageCamera(async () => null, path.join(dir, "work"));
    expect(
      await camera.shoot({ html: "<p>x</p>", folder: null, viewport: { w: 100, h: 100 }, scroll: { x: 0, y: 0 }, strokes: [] }),
    ).toBeNull();
  });
});
