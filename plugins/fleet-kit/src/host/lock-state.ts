// Inspect and, on the user's explicit request, clear the shared
// opencode.json lock (see config-lock.ts). Automatic recovery stays in
// config-lock.ts; this is only for the panel's "Reset" button when a lock or
// its recovery guard has been stuck for minutes.
import { lstat, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const STUCK_MS = 120_000;

export interface LockInfo {
  owner: string;
  since: string;
}

async function info(directory: string): Promise<LockInfo | null> {
  const stat = await lstat(directory).catch(() => null);
  if (stat === null || !stat.isDirectory()) return null;
  let owner = "unknown";
  let since = new Date(stat.mtimeMs).toISOString();
  try {
    const value = JSON.parse(await readFile(`${directory}/owner.json`, "utf8")) as { plugin?: unknown; createdAt?: unknown };
    if (typeof value.plugin === "string") owner = value.plugin;
    if (typeof value.createdAt === "string") since = value.createdAt;
  } catch {
    // An unreadable owner file is reported as "unknown".
  }
  return { owner, since };
}

/** The lock (or its recovery guard), when it is held. */
export async function lockState(configFile: string): Promise<LockInfo | null> {
  return (await info(`${configFile}.bb-config-lock`)) ?? (await info(`${configFile}.bb-config-lock.recovery`));
}

/** Clear a lock held for over two minutes. Returns whether anything was cleared. */
export async function resetStuckLock(configFile: string): Promise<boolean> {
  let cleared = false;
  for (const directory of [`${configFile}.bb-config-lock.recovery`, `${configFile}.bb-config-lock`]) {
    const stat = await lstat(directory).catch(() => null);
    if (stat === null || !stat.isDirectory()) continue;
    const held = await info(directory);
    const since = Date.parse(held?.since ?? "") || stat.mtimeMs;
    if (Date.now() - since < STUCK_MS) continue;
    const moved = `${directory}.reset-${Date.now()}-${randomUUID()}`;
    await rename(directory, moved);
    await rm(moved, { recursive: true, force: true });
    cleared = true;
  }
  return cleared;
}
