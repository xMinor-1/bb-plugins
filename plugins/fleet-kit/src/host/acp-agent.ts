// Registers OpenCode as bb's agent through the ACP wrapper: the entry `opencode` in the customAgents setting of bb's
// ACP provider, with an absolute path, so bb never picks another OpenCode from PATH. The wrapper runs under the program
// that runs bb: the app in its Node mode, or Node. Nothing else has to be installed for it.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ACP_SHIM_SOURCE } from "./acp-shim-source.js";

export const ACP_PROVIDER_PLUGIN = "provider-acp";
export const ACP_SHIM_FILE = "bb-acp-shim.cjs";

export interface AgentRuntime {
  execPath: string;
  /** bb runs inside the desktop app: its executable needs the Node-mode switch. */
  electron: boolean;
}

export function agentRuntime(): AgentRuntime {
  return { execPath: process.execPath, electron: process.versions.electron !== undefined };
}

export function agentEntry(runtime: AgentRuntime, shim: string, opencode: string, messages: { notReady: string }) {
  const env: Record<string, string> = { ACP_SHIM_NOT_READY: messages.notReady };
  if (runtime.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return {
    id: "opencode",
    displayName: "opencode",
    command: runtime.execPath,
    args: [shim, opencode, "acp"],
    env,
    dialect: "opencode",
    providerUsage: true,
    supportsManualCompaction: true,
  };
}

/** The new value of customAgents: the person's other agents stay; a value that cannot be read gives way (see backup). */
export function mergeAgents(current: string, ours: object): { value: string; kept: boolean } {
  let list: unknown[] | null = null;
  try {
    const parsed: unknown = JSON.parse(current.trim() === "" ? "[]" : current);
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    // unreadable
  }
  if (list === null) return { value: JSON.stringify([ours]), kept: false };
  return { value: JSON.stringify([...list.filter((agent) => (agent as { id?: unknown } | null)?.id !== "opencode"), ours]), kept: true };
}

/** Writes the wrapper next to OpenCode; the file changes only with a new Fleet Kit. */
export async function writeShim(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, ACP_SHIM_FILE);
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === ACP_SHIM_SOURCE) return path;
  const fresh = `${path}.tmp`;
  await writeFile(fresh, ACP_SHIM_SOURCE, "utf8");
  await rename(fresh, path);
  return path;
}

/** A copy of a value about to be replaced; it may hold keys, so only the person can read it. */
export async function backupAgents(directory: string, current: string, now: Date): Promise<string> {
  const folder = join(directory, "backup");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `provider-acp-customAgents.${now.toISOString().replace(/[-:.]/g, "").replace(/Z$/, "")}.json`);
  await writeFile(file, current, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
  return file;
}
