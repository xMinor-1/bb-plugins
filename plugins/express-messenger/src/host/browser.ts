// A Chromium-based browser on this machine, driven over the DevTools protocol with Node's own
// WebSocket (no dependencies). The browser keeps its own profile in the plugin's data directory, so
// the sign-in survives restarts and the person's everyday browser profile is never touched.
// The DevTools port is chosen by the browser (port 0) and listens on 127.0.0.1 only.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    readonly code: "no-browser" | "no-websocket" | "launch" | "page" | "closed",
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** One DevTools connection to the browser; page commands go through a flattened session. */
class Connection {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const waiting = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!waiting) return;
      this.pending.delete(message.id!);
      if (message.error) waiting.reject(new BrowserError("page", message.error.message ?? "DevTools error"));
      else waiting.resolve(message.result);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const waiting of this.pending.values()) waiting.reject(new BrowserError("closed", "The browser closed."));
      this.pending.clear();
    });
  }

  static open(url: string): Promise<Connection> {
    if (typeof WebSocket === "undefined") throw new BrowserError("no-websocket", "This bb runs on a Node.js without WebSocket (Node 22 or newer is needed).");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Connection(ws)), { once: true });
      ws.addEventListener("error", () => reject(new BrowserError("launch", "Could not connect to the browser over DevTools.")), { once: true });
    });
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
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

async function devtoolsVersion(port: number): Promise<{ webSocketDebuggerUrl: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? ((await response.json()) as { webSocketDebuggerUrl: string }) : null;
  } catch {
    return null;
  }
}

/** The port a browser on this profile listens on, from the file Chromium writes into the profile. */
function activePort(profileDir: string): number | null {
  try {
    const port = Number(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export interface LaunchOptions {
  readonly browserPath: string;
  readonly profileDir: string;
  readonly url: string;
  readonly headless: boolean;
}

/** The web client in one browser tab. */
export class Page {
  private constructor(
    private readonly connection: Connection,
    private readonly sessionId: string,
    private readonly child: ChildProcess | null,
    readonly headless: boolean,
  ) {}

  /**
   * Starts the browser on the profile, or attaches to one already running on it (a browser left by
   * a worker that stopped), and opens the web client.
   */
  static async open({ browserPath, profileDir, url, headless }: LaunchOptions): Promise<Page> {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    let child: ChildProcess | null = null;
    const leftPort = activePort(profileDir);
    let version = leftPort ? await devtoolsVersion(leftPort) : null;
    if (version && !headless) {
      // A window is wanted, the browser left behind has none: close it first.
      await closeBrowserAt(version.webSocketDebuggerUrl);
      version = null;
    }
    if (!version) {
      const args = [
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        `--auth-server-allowlist=${authAllowlist(url)}`,
        ...(headless ? ["--headless=new", "--window-size=1280,900"] : ["--new-window"]),
        "about:blank",
      ];
      child = spawn(browserPath, args, { stdio: ["ignore", "ignore", "pipe"], shell: false, windowsHide: headless });
      const port = await new Promise<number>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(() => reject(new BrowserError("launch", "The browser did not start in 30 s (is its profile open in another browser window?).")), 30_000);
        child!.stderr!.on("data", (chunk: Buffer) => {
          buffered = (buffered + chunk.toString("utf8")).slice(-4000);
          const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buffered);
          if (found) {
            clearTimeout(timer);
            resolve(Number(found[1]));
          }
        });
        child!.once("exit", (code) => {
          clearTimeout(timer);
          reject(new BrowserError("launch", `The browser exited at start (code ${code}).`));
        });
        child!.once("error", (error) => {
          clearTimeout(timer);
          reject(new BrowserError("launch", `The browser did not start: ${error.message}`));
        });
      }).catch((error: unknown) => {
        child?.kill();
        throw error;
      });
      child.stderr!.resume();
      for (let i = 0; i < 20 && !version; i++) {
        version = await devtoolsVersion(port);
        if (!version) await sleep(250);
      }
      if (!version) {
        child.kill();
        throw new BrowserError("launch", "The browser started but does not answer over DevTools.");
      }
    }
    const connection = await Connection.open(version.webSocketDebuggerUrl);
    try {
      const origin = new URL(url).origin;
      const { targetInfos } = await connection.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
      let target = targetInfos.find((info) => info.type === "page" && info.url.startsWith(origin));
      const navigate = !target;
      target ??= targetInfos.find((info) => info.type === "page");
      const targetId = target?.targetId ?? (await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      if (navigate) await connection.send("Page.navigate", { url }, sessionId);
      return new Page(connection, sessionId, child, headless);
    } catch (error) {
      connection.close();
      child?.kill();
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

  /** Types text into the focused field as one input, the way a paste does. */
  insertText(text: string): Promise<unknown> {
    return this.connection.send("Input.insertText", { text }, this.sessionId);
  }

  /** Presses Enter; `modifiers`: 2 Ctrl, 4 Cmd. */
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
    if (!this.child || this.child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => this.child!.once("exit", () => resolve()));
  }

  async close(): Promise<void> {
    await this.connection.send("Browser.close", {}, undefined, 5000).catch(() => undefined);
    this.connection.close();
    const child = this.child;
    if (child && child.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}

async function closeBrowserAt(webSocketDebuggerUrl: string): Promise<void> {
  try {
    const connection = await Connection.open(webSocketDebuggerUrl);
    await connection.send("Browser.close", {}, undefined, 5000).catch(() => undefined);
    connection.close();
    await sleep(1500);
  } catch {
    // gone already
  }
}
