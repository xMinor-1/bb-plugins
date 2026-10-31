// Configuration check only. OpenCode itself enforces managed provider policy.
import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { openCodeMajor } from "./opencode-config.js";
import { parseAllowedProviders } from "../shared/settings.js";
import { verifyAvailableModels } from "../shared/available-models.js";
import type { ProviderPolicyDecision } from "../shared/provider-policy.js";
import { resolveOpenCodeLocation } from "./opencode-location.js";

export interface ModelCheckOptions {
  allowedProviders: string;
  projectDirectory: string;
  /** Exact environment used to launch acp-opencode; do not reconstruct it here. */
  environment: NodeJS.ProcessEnv;
  opencodeConfigDir?: string;
  /** Native executable, or [node, absolute CLI JS entry] for npm on Windows.
   * Shell/cmd wrappers are deliberately not interpreted. */
  command?: readonly [string, ...string[]];
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface CommandResult { exitCode: number | null; stdout: string; failed: boolean }

/** Resolves only after the child closes, including cancellation and timeouts.
 * stdout is bounded; stderr is drained and discarded, never put in errors/logs. */
async function run(command: readonly [string, ...string[]], args: string[], options: ModelCheckOptions): Promise<CommandResult> {
  if (options.signal?.aborted) return { exitCode: null, stdout: "", failed: true };
  return await new Promise((resolve) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd: options.projectDirectory,
      env: { ...options.environment },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let size = 0;
    let failed = false;
    let termination: Promise<void> | undefined;
    const terminateTree = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        // Windows termination is awaited in stop(); do not shell through a .cmd shim.
        child.kill("SIGKILL");
      } else {
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch {
          child.kill(force ? "SIGKILL" : "SIGTERM");
        }
      }
    };
    const stop = () => {
      failed = true;
      if (termination) return;
      termination = new Promise((done) => {
        if (process.platform === "win32" && child.pid) {
          execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, (error) => {
            if (error) child.kill("SIGKILL");
            done();
          });
        } else {
          terminateTree(false);
          // A closed launcher does not imply that grandchildren have exited.
          setTimeout(() => { terminateTree(true); done(); }, 500);
        }
      });
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 20_000);
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Cover cancellation between the initial check and listener registration.
    if (options.signal?.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) stop();
      else output.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => { failed = true; });
    child.once("close", async (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      await termination;
      resolve({ exitCode: code, stdout: failed ? "" : Buffer.concat(output).toString("utf8"), failed });
    });
  });
}

export async function checkOpenCodeConfiguration(options: ModelCheckOptions): Promise<ProviderPolicyDecision> {
  let providers: string[];
  try { providers = parseAllowedProviders(options.allowedProviders); } catch {
    return { state: "blocked", reason: "The allowed provider setting is invalid." };
  }
  if (!providers.length) return verifyAvailableModels("", null, undefined);
  if (!isAbsolute(options.projectDirectory)) return {
    state: "blocked", reason: "Configuration check requires an absolute project directory.",
  };
  const command = options.command ?? ["opencode"];
  try {
    const location = resolveOpenCodeLocation(options);
    options = { ...options, environment: location.environment };
    const version = await run(command, ["--version"], options);
    if (version.failed || version.exitCode !== 0) throw new Error();
    if (openCodeMajor(version.stdout) === 1) return {
      state: "blocked", reason: "Update OpenCode to 2.x before enabling Qlik with provider restrictions. Your manual legacy MCP configuration is unchanged.",
    };
    const models = await run(command, ["models", "--standalone"], options);
    if (models.failed) throw new Error();
    return verifyAvailableModels(options.allowedProviders, models.exitCode, models.stdout);
  } catch {
    return { state: "blocked", reason: "OpenCode configuration could not be checked. Qlik access is disabled.",
    };
  }
}
