// A Chromium-based browser on this machine, driven over the DevTools protocol through a pipe
// (--remote-debugging-pipe, no dependencies). Nothing listens on a port and no file names one, so
// only the process that started the browser can drive it, and the browser ends when that process
// does. The browser keeps its own profile in the plugin's data directory, so the sign-in survives
// restarts and the person's everyday browser profile is never touched.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where Chromium-based browsers live. Absolute paths only: PATH is not consulted. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Yandex.app/Contents/MacOS/Yandex",
    ];
  }
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((root): root is string => !!root);
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "Yandex", "YandexBrowser", "Application", "browser.exe"),
    ]);
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
}

export function findBrowser(): string | null {
  return browserCandidates().find((path) => existsSync(path)) ?? null;
}

/** Kerberos / Windows sign-in is offered only to the web client's own domain and its neighbours. */
export function authAllowlist(webClientUrl: string): string {
  const host = new URL(webClientUrl).hostname;
  const labels = host.split(".");
  return labels.length > 2 ? `*.${labels.slice(1).join(".")}` : host;
}

export class BrowserError extends Error {
  constructor(
    readonly code: "no-browser" | "launch" | "page" | "closed" | "unreachable",
    message: string,
  ) {
    super(message);
  }
}

/** The messenger's address did not open: a matter of the network, not of the sign-in. */
export function unreachableError(detail?: string): BrowserError {
  return new BrowserError("unreachable", `The messenger does not open from this machine${detail ? ` (${detail})` : ""}. Check the network or VPN and try again.`);
}

const START_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 45_000;
/** A browser that just ended may still hold the profile for a moment: a new one would hand over to it and exit. */
const START_ATTEMPTS = 4;
const START_RETRY_MS = 1500;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** One DevTools connection over the browser's pipe: JSON messages, each ended by a NUL byte. */
class Connection {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private partial: Buffer[] = [];

  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
  ) {
    output.on("data", (chunk: Buffer) => this.receive(chunk));
    output.on("close", () => this.shut());
    output.on("error", () => this.shut());
    input.on("error", () => this.shut());
  }

  /** A long message arrives in many chunks: joined once, when its end comes. */
  private receive(chunk: Buffer): void {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      this.partial.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.partial).toString("utf8");
      this.partial = [];
      start = end + 1;
      this.deliver(text);
    }
    if (start < chunk.length) this.partial.push(chunk.subarray(start));
  }

  private deliver(text: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const waiting = message.id !== undefined ? this.pending.get(message.id) : undefined;
    if (!waiting) return;
    this.pending.delete(message.id!);
    if (message.error) waiting.reject(new BrowserError("page", message.error.message ?? "DevTools error"));
    else waiting.resolve(message.result);
  }

  private shut(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) waiting.reject(new BrowserError("closed", "The browser closed."));
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserError("closed", "The browser closed."));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError("page", `The browser did not answer ${method} in ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.input.write(`${JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })}\0`);
    });
  }

  close(): void {
    this.shut();
    this.input.destroy();
    this.output.destroy();
  }
}

export interface LaunchOptions {
  readonly browserPath: string;
  readonly profileDir: string;
  readonly url: string;
  readonly headless: boolean;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/** Starts the browser and waits until it answers; a browser that exits at once is reported as such. */
function startBrowser({ browserPath, profileDir, url, headless }: LaunchOptions): Promise<{ child: ChildProcess; connection: Connection }> {
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--auth-server-allowlist=${authAllowlist(url)}`,
    ...(headless ? ["--headless=new", "--window-size=1280,900"] : ["--new-window"]),
    "about:blank",
  ];
  // Descriptor 3 is what the browser reads, 4 is what it writes.
  const child = spawn(browserPath, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], shell: false, windowsHide: headless });
  const connection = new Connection(child.stdio[3] as Writable, child.stdio[4] as Readable);
  return new Promise((resolve, reject) => {
    const fail = (error: BrowserError) => {
      connection.close();
      child.kill();
      reject(error);
    };
    child.once("error", (error) => fail(new BrowserError("launch", `The browser did not start: ${error.message}`)));
    child.once("exit", (code) => fail(new BrowserError("launch", `The browser exited at start (code ${code}). Is its profile open in another browser window?`)));
    connection.send("Browser.getVersion", {}, undefined, START_TIMEOUT_MS).then(
      () => {
        child.removeAllListeners("exit");
        child.removeAllListeners("error");
        // A failure after the start shows on the connection.
        child.on("error", () => undefined);
        child.on("exit", () => connection.close());
        resolve({ child, connection });
      },
      (error: unknown) => {
        if (error instanceof BrowserError && error.code === "closed") return; // the exit handler reports it
        fail(new BrowserError("launch", `The browser did not start in ${START_TIMEOUT_MS / 1000} s. Is its profile open in another browser window?`));
      },
    );
  });
}

/** The web client in one browser tab. */
export class Page {
  private constructor(
    private readonly connection: Connection,
    private readonly sessionId: string,
    private readonly child: ChildProcess,
    readonly headless: boolean,
  ) {}

  /** Starts the browser on the profile and opens the web client. */
  static async open(options: LaunchOptions): Promise<Page> {
    mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
    let started: Awaited<ReturnType<typeof startBrowser>> | null = null;
    for (let attempt = 1; !started; attempt++) {
      try {
        started = await startBrowser(options);
      } catch (error) {
        if (attempt >= START_ATTEMPTS) throw error;
        await sleep(START_RETRY_MS);
      }
    }
    const { child, connection } = started;
    try {
      const { targetInfos } = await connection.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
      const blank = targetInfos.find((info) => info.type === "page");
      const targetId = blank?.targetId ?? (await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      const navigated = await connection.send<{ errorText?: string }>("Page.navigate", { url: options.url }, sessionId, NAVIGATE_TIMEOUT_MS).catch((error: unknown) => {
        // No answer to a navigation: the address neither opens nor refuses.
        if (error instanceof BrowserError && error.code === "page") throw unreachableError("no answer");
        throw error;
      });
      // ERR_ABORTED is a navigation replaced by the next one, such as a redirect.
      if (navigated.errorText && navigated.errorText !== "net::ERR_ABORTED") throw unreachableError(navigated.errorText);
      return new Page(connection, sessionId, child, options.headless);
    } catch (error) {
      connection.close();
      child.kill();
      await stopChild(child);
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.connection.isClosed;
  }

  /** Evaluates an expression in the page and returns its JSON value; promises are awaited. */
  async evaluate<T>(expression: string, timeoutMs = 120_000): Promise<T> {
    const result = await this.connection.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new BrowserError("page", `The page failed: ${String(detail.exception?.description ?? detail.text ?? "error").split("\n")[0]}`);
    }
    return result.result.value as T;
  }

  /** Clicks the middle of the first element the selector finds. */
  async click(selector: string): Promise<boolean> {
    const at = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!at) return false;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.connection.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, this.sessionId);
    }
    return true;
  }

  /** Clicks a point of the page, as a person's mouse does. */
  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.connection.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, this.sessionId);
    }
  }

  /** Types text into the focused field as one input, the way a paste does. */
  insertText(text: string): Promise<unknown> {
    return this.connection.send("Input.insertText", { text }, this.sessionId);
  }

  /** Presses a key without text, such as Backspace; `commands` are editing commands, such as selectAll. */
  async pressKey(key: string, code: string, keyCode: number, modifiers = 0, commands?: string[]): Promise<void> {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.connection.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(commands ? { commands } : {}) }, this.sessionId);
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, this.sessionId);
  }

  /** Presses Enter; `modifiers`: 2 Ctrl, 4 Cmd, 8 Shift. */
  async pressEnter(modifiers = 0): Promise<void> {
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers };
    await this.connection.send(
      "Input.dispatchKeyEvent",
      modifiers ? { type: "rawKeyDown", ...base } : { type: "keyDown", text: "\r", unmodifiedText: "\r", ...base },
      this.sessionId,
    );
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, this.sessionId);
  }

  /** Waits for the browser to exit by itself: the person closed the window. */
  exited(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => this.child.once("exit", () => resolve()));
  }

  async close(): Promise<void> {
    await this.connection.send("Browser.close", {}, undefined, 5000).catch(() => undefined);
    this.connection.close();
    await stopChild(this.child);
  }
}
