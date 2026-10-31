// Inspect and, on the user's explicit request, clear the shared
// opencode.json lock (see config-lock.ts). Automatic recovery stays in
// config-lock.ts; this is only for the panel's "Reset" button when a lock or
// its recovery guard has been stuck for minutes.
import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { ownerAt, owns, removeIfSame, withRecoveryGuard, type LockOwner } from "./config-lock.js";
import { WRITER } from "./opencode-config.js";

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

/** The directory's identity and owner when it has been held for over two minutes, else null. */
async function stuck(directory: string): Promise<{ stat: Stats; owner: LockOwner | null } | null> {
  const stat = await lstat(directory).catch(() => null);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  const held = await info(directory);
  const since = Date.parse(held?.since ?? "") || stat.mtimeMs;
  if (Date.now() - since < STUCK_MS) return null;
  return { stat, owner: await ownerAt(directory).catch(() => null) };
}

/**
 * Clear a lock held for over two minutes, on the user's request. A recovery
 * guard stuck that long is cleared first; the lock itself is cleared only
 * while this call holds the guard, and only if it is still the same directory
 * that was found stuck. Returns whether anything was cleared.
 */
export async function resetStuckLock(configFile: string): Promise<boolean> {
  const lock = `${configFile}.bb-config-lock`;
  let cleared = false;
  const guard = await stuck(`${lock}.recovery`);
  if (guard !== null) cleared = await removeIfSame(`${lock}.recovery`, guard.stat, owns.same(guard.owner));
  const result = await withRecoveryGuard(lock, WRITER, async () => {
    const held = await stuck(lock);
    return held === null ? false : removeIfSame(lock, held.stat, owns.same(held.owner));
  });
  return cleared || result === true;
}
