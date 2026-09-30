// Pictures of HTML pages with a drawing on top, for the agent. The panel
// sends the page as it stood when the user drew on it (the bridge serializes
// the live DOM, scripts removed); a headless Chrome on the bb server opens it
// at the same viewport, scrolls where the user was, lays the strokes over it,
// and takes a screenshot.
//
// Chrome runs with the page's scripts disabled and every request checked: a
// file may only load from the reviewed page's own folder (what the panel's
// preview of that folder already serves), so a crafted page cannot show
// other files on the server in its picture. Chrome is driven over its
// DevTools pipe, so no extra package is needed; without Chrome, drawings go
// to the agent as the list of elements they touch.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DRAWING_JS } from "./drawing.js";
import type { Stroke } from "./types.js";

function wellKnownChromes(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ];
    case "win32":
      return [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ];
    default:
      return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  }
}

const PATH_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "microsoft-edge"];

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    if (process.platform !== "win32") await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The configured browser, else Chrome or Chromium on PATH or where it installs. */
export async function findChrome(configured: string): Promise<string | null> {
  if (configured.trim()) return (await isExecutable(configured.trim())) ? configured.trim() : null;
  const fromPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => PATH_NAMES.map((name) => path.join(directory, name)));
  for (const candidate of [...fromPath, ...wellKnownChromes()]) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface PageShot {
  html: string;
  /** Folder the page's relative files load from; null when it is not on this machine. */
  folder: string | null;
  viewport: { w: number; h: number };
  scroll: { x: number; y: number };
  strokes: Stroke[];
}

/** The marked `<base>` the server put into the page for the review frame. */
const REVIEW_BASE = /<base\b[^>]*\bdata-doc-review-base\b[^>]*>/gi;
/** Markup that would move the page elsewhere or run code with scripts off. */
const NAVIGATING_META = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi;

/** The page for the headless browser: relative files from its folder, nothing that navigates away. */
export function prepareShotHtml(html: string, folder: string | null): string {
  const base = folder ? `<base href="${pathToFileURL(folder.endsWith("/") ? folder : `${folder}/`).href}">` : "";
  let replaced = false;
  const out = html
    .replace(REVIEW_BASE, () => {
      if (replaced) return "";
      replaced = true;
      return base;
    })
    .replace(NAVIGATING_META, "");
  if (replaced || !base) return out;
  const head = /<head\b[^>]*>/i.exec(out);
  const at = head ? head.index + head[0].length : 0;
  return out.slice(0, at) + base + out.slice(at);
}

/** Runs in the page: puts back scroll positions, lays the strokes on top, picks what to capture. */
const ARRANGE_JS = String.raw`(function (input) {
  ${DRAWING_JS}
  var doc = document;
  var scrolled = doc.querySelectorAll("[data-doc-review-scroll]");
  for (var i = 0; i < scrolled.length; i += 1) {
    var parts = String(scrolled[i].getAttribute("data-doc-review-scroll")).split(",");
    scrolled[i].scrollLeft = Number(parts[0]) || 0;
    scrolled[i].scrollTop = Number(parts[1]) || 0;
  }
  var svg = drawingSvg(doc, input.strokes, 1);
  svg.style.zIndex = "2147483647";
  doc.documentElement.appendChild(svg);
  var width = window.innerWidth;
  var height = window.innerHeight;
  var margin = 32;
  var b = drawingBounds(input.strokes) || { x0: 0, y0: 0, x1: 0, y1: 0 };
  var x = input.scroll.x;
  var y = input.scroll.y;
  // Keep the user's view when the whole drawing is in it; otherwise bring the drawing in.
  if (b.x0 < x || b.x1 > x + width) x = Math.max(0, b.x0 - margin);
  if (b.y1 - b.y0 + 2 * margin > height) {
    window.scrollTo(x, Math.max(0, b.y0 - margin));
    return { clip: { x: window.scrollX, y: Math.max(0, b.y0 - margin), width: width, height: b.y1 - b.y0 + 2 * margin } };
  }
  if (b.y0 < y || b.y1 > y + height) y = Math.max(0, b.y0 - (height - (b.y1 - b.y0)) / 2);
  window.scrollTo(x, y);
  return { clip: null };
})`;

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

/** Photographs one page at a time; each shot starts and ends its own browser. */
export class PageCamera {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly chrome: () => Promise<string | null>,
    private readonly workDir: string,
  ) {}

  shoot(shot: PageShot): Promise<Buffer | null> {
    const run = this.queue.then(() => this.shootNow(shot));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async shootNow(shot: PageShot): Promise<Buffer | null> {
    const executable = await this.chrome();
    if (!executable) return null;
    await mkdir(this.workDir, { recursive: true });
    const name = `shot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(this.workDir, `${name}.html`);
    const profile = path.join(this.workDir, `${name}-profile`);
    await writeFile(file, prepareShotHtml(shot.html, shot.folder));
    try {
      return await capture(executable, pathToFileURL(file).href, profile, shot);
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
      await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }
}

const SHOT_TIMEOUT_MS = 20_000;
/** A page whose pictures or fonts keep loading is photographed after this long. */
const LOAD_WAIT_MS = 6_000;

/** Whether a request from the page may go through. */
export function shotRequestAllowed(url: string, pageUrl: string, folder: string | null): boolean {
  if (url === pageUrl) return true;
  if (/^(?:data|blob|about):/i.test(url)) return true;
  if (/^https?:/i.test(url)) return true;
  if (!/^file:/i.test(url) || !folder) return false;
  try {
    const target = path.resolve(fileURLToPath(url));
    const root = path.resolve(folder);
    return target === root || target.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

async function capture(executable: string, pageUrl: string, profile: string, shot: PageShot): Promise<Buffer> {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "about:blank",
  ];
  // Chrome refuses its sandbox as root (a server or container run as root).
  if (process.getuid?.() === 0) args.unshift("--no-sandbox");
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const toChrome = child.stdio[3] as NodeJS.WritableStream;
  const fromChrome = child.stdio[4] as NodeJS.ReadableStream;

  let nextId = 0;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(message: Message) => void>();
  let buffer = "";
  let failed: Error | null = null;
  const fail = (error: Error) => {
    failed ??= error;
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  };
  fromChrome.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let at: number;
    while ((at = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, at)) as Message;
      buffer = buffer.slice(at + 1);
      if (message.id !== undefined) {
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    }
  });
  child.on("error", (error) => fail(error));
  child.on("exit", () => fail(new Error("Chrome exited before the picture was taken.")));
  // A write after Chrome exits fails through `fail` above.
  (toChrome as NodeJS.WritableStream & { on: (event: string, listener: () => void) => void }).on("error", () => undefined);

  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (failed) return reject(failed);
      nextId += 1;
      waiting.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
      toChrome.write(`${JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });

  const timer = setTimeout(() => fail(new Error("Chrome took too long to photograph the page.")), SHOT_TIMEOUT_MS);
  try {
    const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    listeners.add((message) => {
      if (message.method !== "Fetch.requestPaused" || message.sessionId !== sessionId) return;
      const params = message.params as { requestId: string; request: { url: string } };
      const next = shotRequestAllowed(params.request.url, pageUrl, shot.folder)
        ? send("Fetch.continueRequest", { requestId: params.requestId }, sessionId)
        : send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId);
      next.catch(() => undefined);
    });
    const loaded = new Promise<void>((resolve) => {
      listeners.add((message) => {
        if (message.method === "Page.loadEventFired" && message.sessionId === sessionId) resolve();
      });
    });
    const w = Math.round(shot.viewport.w);
    const h = Math.round(shot.viewport.h);
    // A phone-sized view is captured at twice the pixels so its text stays readable.
    const scale = w < 600 ? 2 : 1;
    await send("Page.enable", {}, sessionId);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await send("Emulation.setScriptExecutionDisabled", { value: true }, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile: false }, sessionId);
    await send("Page.navigate", { url: pageUrl }, sessionId);
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, LOAD_WAIT_MS))]);
    const arranged = await send<{ result: { value?: { clip: { x: number; y: number; width: number; height: number } | null } } }>(
      "Runtime.evaluate",
      { expression: `${ARRANGE_JS}(${JSON.stringify({ strokes: shot.strokes, scroll: shot.scroll })})`, returnByValue: true },
      sessionId,
    );
    const clip = arranged.result.value?.clip ?? null;
    const picture = await send<{ data: string }>(
      "Page.captureScreenshot",
      clip ? { format: "png", clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : { format: "png" },
      sessionId,
    );
    return Buffer.from(picture.data, "base64");
  } finally {
    clearTimeout(timer);
    // Wait for Chrome to let go of its profile before the folder is removed.
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    send("Browser.close").catch(() => undefined);
    const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(kill);
  }
}
