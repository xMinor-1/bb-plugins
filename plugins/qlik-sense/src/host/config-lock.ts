// Shared protocol with fleet-kit. Keep both plugin copies and tests in sync.
import { mkdir, readFile, writeFile, lstat, rename, rm } from "node:fs/promises";
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

async function ownerAt(lock: string): Promise<LockOwner | null> {
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

async function recoverStale(lock: string, plugin: string): Promise<boolean> {
  // Serialize recoverers: a second stale check must not rename a newly acquired lock.
  // Never auto-reap this guard: doing so would recreate the very same race.
  const recovery = `${lock}.recovery`;
  try { await mkdir(recovery, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    // Allows the future user-triggered reset to prove that the recovery owner is dead.
    await writeFile(`${recovery}/owner.json`, JSON.stringify({
      plugin, pid: process.pid, host: hostname(), createdAt: new Date().toISOString(),
    }), { flag: "wx", mode: 0o600 });
    return await recoverStaleUnderGuard(lock);
  } finally { await rm(recovery, { recursive: true }); }
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
  if (!current || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) return false;
  const stale = `${lock}.stale-${Date.now()}-${randomUUID()}`;
  try { await rename(lock, stale); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(stale, { recursive: true });
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
      const owner: LockOwner = { plugin, pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), token: randomUUID() };
      try { await writeFile(`${lock}/owner.json`, JSON.stringify(owner), { flag: "wx", mode: 0o600 }); } catch (error) {
        await rm(lock, { recursive: true });
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if ((await ownerAt(lock))?.token !== owner.token) throw new Error("OpenCode configuration lock ownership changed.");
        await rm(lock, { recursive: true });
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
