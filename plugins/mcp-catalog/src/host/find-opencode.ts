// Copied from plugins/fleet-kit/src/host/find-opencode.ts (commit ccc161e).
// Finds the OpenCode executable that bb's ACP provider starts: bb resolves
// `opencode` on the user's PATH (the server receives the same normalized PATH),
// so Fleet Kit does the same and asks it for its version.
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface OpenCodeBinary {
  command: [string, ...string[]];
  version: string;
}

/** Unwrap npm's Windows .cmd shim to the native executable it starts. */
export function unwrapNpmShim(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && /\.cmd$/i.test(path)) {
    const directory = path.replace(/[\\/][^\\/]+$/, "");
    return join(directory, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  }
  return path;
}

export async function findOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const names = platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"];
  const directories = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  if (platform === "win32" && env.APPDATA) directories.push(join(env.APPDATA, "npm"));
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        const resolved = unwrapNpmShim(candidate, platform);
        await access(resolved, constants.F_OK);
        return resolved;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function version(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (out.length < 4096) out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split(/\r?\n/).pop() ?? null : null);
    });
  });
}

/** "opencode v2.2.5" → "2.2.5"; output without a version is kept as is. */
export function normalizeVersion(reported: string): string {
  return /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(reported)?.[0] ?? reported;
}

export async function findOpenCode(env: NodeJS.ProcessEnv): Promise<OpenCodeBinary | null> {
  const path = await findOnPath(env);
  if (path === null) return null;
  const reported = await version(path, env);
  return reported === null ? null : { command: [path], version: normalizeVersion(reported) };
}
