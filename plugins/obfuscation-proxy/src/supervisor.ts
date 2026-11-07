// Runs the masking proxy as a child process on a free loopback port and
// reports its state. One run per call to `run`; a crash rejects so bb's
// background service restarts it with backoff.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { NotConfiguredError } from "./binary";
import { parseProxyLogLine, type ProxyLogEvent } from "./log-parser";
import { renderProxyConfig } from "./proxy-config";
import type { ProxyState, ProxyStatus } from "./shared";

export interface SupervisorOptions {
  /** Plugin-owned working directory for the config file. */
  dir: string;
  resolveBinary(signal: AbortSignal): Promise<string>;
  upstream: string;
  extraConfig: string;
  onEvent(event: ProxyLogEvent): void;
  onStatus(status: ProxyStatus): void;
  startTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  now?: () => number;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("No free port."))));
    });
  });
}

export class ProxySupervisor {
  private current: ProxyStatus;
  private address: string | null = null;

  constructor(private readonly options: SupervisorOptions) {
    this.current = { state: "stopped", message: null, since: this.now() };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get status(): ProxyStatus {
    return this.current;
  }

  /** Base URL of the running proxy, or null when it is not serving. */
  get url(): string | null {
    return this.current.state === "running" ? this.address : null;
  }

  private set(state: ProxyState, message: string | null = null): void {
    if (this.current.state === state && this.current.message === message) return;
    this.current = { state, message, since: this.now() };
    this.options.onStatus(this.current);
  }

  /** Starts the proxy and resolves when `signal` aborts; rejects if it dies. */
  async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.set("starting");
    let binary: string;
    try {
      binary = await this.options.resolveBinary(signal);
    } catch (cause) {
      if (cause instanceof NotConfiguredError) {
        // Waiting is not a crash: nothing to retry until the settings change.
        this.set("not-configured", cause.message);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        this.set("stopped");
        return;
      }
      this.set("failed", cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
    if (signal.aborted) return;

    const port = await freePort();
    await mkdir(this.options.dir, { recursive: true });
    const configPath = join(this.options.dir, "config.yaml");
    try {
      await writeFile(
        configPath,
        renderProxyConfig({ port, upstream: this.options.upstream, extra: this.options.extraConfig }),
        { mode: 0o600 },
      );
    } catch (cause) {
      this.set("failed", cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }

    const child = (this.options.spawnProcess ?? spawn)(binary, ["serve", "--config", configPath], {
      cwd: this.options.dir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.address = `http://127.0.0.1:${port}`;
    await this.watch(child, signal);
  }

  private watch(child: ChildProcess, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let lastError: string | null = null;
      let stopping = false;
      const startTimer = setTimeout(() => {
        if (this.current.state !== "starting") return;
        lastError = lastError ?? "The proxy did not start listening in time.";
        child.kill();
      }, this.options.startTimeoutMs ?? 15_000);

      const onLine = (line: string) => {
        const event = parseProxyLogLine(line);
        if (event.kind === "listening") this.set("running");
        if (event.kind === "error") lastError = event.message;
        this.options.onEvent(event);
      };
      if (child.stdout) createInterface({ input: child.stdout }).on("line", onLine);
      if (child.stderr) createInterface({ input: child.stderr }).on("line", onLine);

      const stop = () => {
        stopping = true;
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
        force.unref();
      };
      signal.addEventListener("abort", stop, { once: true });

      let closed = false;
      const onClose = (code: number | null) => {
        if (closed) return;
        closed = true;
        clearTimeout(startTimer);
        signal.removeEventListener("abort", stop);
        this.address = null;
        if (stopping || signal.aborted) {
          this.set("stopped");
          resolve();
          return;
        }
        const message = lastError ?? `The proxy exited with code ${code ?? "unknown"}.`;
        this.set("failed", message);
        reject(new Error(message));
      };
      child.once("close", onClose);
      child.once("error", (error) => {
        lastError = error.message;
        // A binary that never started emits no "close".
        if (child.pid === undefined) onClose(null);
      });
    });
  }
}
