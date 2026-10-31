// The opencode.json write lock: a directory `<config>.bb-config-lock` holding
// `owner.json` (plugin, pid, host, time, token). Writers wait while it exists,
// recover an abandoned one under a second directory, `<lock>.recovery`, which
// serializes recoverers, and remove only a directory they can prove is theirs.
//
// Started as a copy of qlik-sense's module (commit c0399a0). Qlik no longer
// writes opencode.json, so Fleet Kit is the only plugin writer and this copy
// evolves on its own; the lock still keeps two syncs, or a sync and a manual
// reset, from writing at once.
import { mkdir, readFile, writeFile, lstat, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";

export interface LockOwner {
  plugin: string;
  pid: number;
  host: string;
  createdAt: string;
  token?: string;
}
export interface LockOptions {
  signal?: AbortSignal;
  /** Default: report the busy owner after two minutes. */
  timeoutMs?: number;
}

export async function ownerAt(lock: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(`${lock}/owner.json`, "utf8"));
    if (value && typeof value.plugin === "string" && Number.isInteger(value.pid) && value.pid > 0 &&
        typeof value.host === "string" && typeof value.createdAt === "string") return value;
    throw new Error("OpenCode configuration lock has invalid owner metadata; inspect it before retrying.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return null;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM and unknown failures are not evidence of a dead process.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const sameEntry = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

/** Ownership checks for removeIfSame, run on the directory after it was moved aside. */
export const owns = {
  /** The directory carries this owner token. */
  token: (token: string) => async (directory: string) => (await ownerAt(directory).catch(() => null))?.token === token,
  /** No owner was ever written: a directory whose owner.json this process failed to write. */
  nobody: async (directory: string) => {
    try {
      return (await ownerAt(directory)) === null;
    } catch {
      return false;
    }
  },
  /** The owner is still the one seen when the directory was judged stale. */
  same: (seen: LockOwner | null) => async (directory: string) =>
    JSON.stringify(await ownerAt(directory).catch(() => "unreadable")) === JSON.stringify(seen),
};

/**
 * Remove the directory at `path` only if it is still the one `expected`
 * describes and `owned` accepts its contents. It is moved aside first and
 * checked after the move, so a directory another process created at the same
 * path in between (file systems reuse inode numbers at once) is put back, not
 * deleted.
 */
export async function removeIfSame(path: string, expected: Stats, owned: (directory: string) => Promise<boolean>): Promise<boolean> {
  const before = await lstat(path).catch(() => null);
  if (!before || !sameEntry(before, expected)) return false;
  const moved = `${path}.removed-${Date.now()}-${randomUUID()}`;
  try { await rename(path, moved); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const after = await lstat(moved).catch(() => null);
  if (after && sameEntry(after, expected) && (await owned(moved))) {
    await rm(moved, { recursive: true, force: true });
    return true;
  }
  // Replaced between the check and the move: not ours, put it back.
  await rename(moved, path).catch(() => undefined);
  return false;
}

/**
 * Run `work` while holding the recovery guard. Returns null when another
 * process holds the guard. The guard is released only while it still carries
 * this call's token, so a guard someone else created is never removed.
 */
export async function withRecoveryGuard<T>(lock: string, plugin: string, work: () => Promise<T>): Promise<T | null> {
  const recovery = `${lock}.recovery`;
  try { await mkdir(recovery, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const mine = await lstat(recovery);
  const token = randomUUID();
  try {
    // Lets a user-triggered reset prove whether the guard's owner is alive.
    await writeFile(`${recovery}/owner.json`, JSON.stringify({
      plugin, pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), token,
    }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    await removeIfSame(recovery, mine, owns.nobody);
    throw error;
  }
  try {
    return await work();
  } finally {
    await removeIfSame(recovery, mine, owns.token(token));
  }
}

async function recoverStale(lock: string, plugin: string): Promise<boolean> {
  // Serialize recoverers: a second stale check must not rename a newly acquired lock.
  // Never auto-reap this guard: doing so would recreate the very same race.
  return (await withRecoveryGuard(lock, plugin, () => recoverStaleUnderGuard(lock))) === true;
}

async function recoverStaleUnderGuard(lock: string): Promise<boolean> {
  const stat = await lstat(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("OpenCode configuration lock is not a regular directory.");
  if (Date.now() - stat.mtimeMs <= 60_000) return false;
  const owner = await ownerAt(lock);
  if (owner && (owner.host !== hostname() || processAlive(owner.pid))) return false;
  if (owner && (!Number.isFinite(Date.parse(owner.createdAt)) || Date.now() - Date.parse(owner.createdAt) <= 60_000)) return false;
  // Recheck identity before moving a stale lock out of the shared path.
  const current = await lstat(lock).catch(() => null);
  if (!current || !sameEntry(current, stat) || current.mtimeMs !== stat.mtimeMs) return false;
  await removeIfSame(lock, stat, owns.same(owner));
  return true;
}

export async function acquireConfigLock(configPath: string, plugin: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const lock = `${configPath}.bb-config-lock`;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const delays = [200, 500, 1000, 2000];
  let attempt = 0;
  while (true) {
    options.signal?.throwIfAborted();
    let acquired = false;
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (acquired) {
      const mine = await lstat(lock);
      const owner: LockOwner = { plugin, pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), token: randomUUID() };
      try { await writeFile(`${lock}/owner.json`, JSON.stringify(owner), { flag: "wx", mode: 0o600 }); } catch (error) {
        // Remove only the directory this call created: if it was recovered as
        // stale meanwhile, the path may already hold another writer's lock.
        await removeIfSame(lock, mine, owns.nobody);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if ((await ownerAt(lock))?.token !== owner.token) throw new Error("OpenCode configuration lock ownership changed.");
        if (!(await removeIfSame(lock, mine, owns.token(owner.token!)))) throw new Error("OpenCode configuration lock ownership changed.");
      };
    }
    if (await recoverStale(lock, plugin)) continue;
    if (Date.now() >= deadline) {
      const owner = await ownerAt(lock);
      throw new Error(owner
        ? `OpenCode configuration is busy: ${owner.plugin} since ${owner.createdAt}.`
        : "OpenCode configuration is busy: lock owner unknown.");
    }
    await pause(Math.min(delays[attempt++] ?? 5000, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
  }
}
