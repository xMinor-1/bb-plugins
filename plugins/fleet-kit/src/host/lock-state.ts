// Inspect and, on the user's explicit request, clear the shared
// opencode.json lock (see config-lock.ts). Automatic recovery stays in
// config-lock.ts; this is only for the panel's "Reset" button when a lock or
// its recovery guard has been stuck for minutes.
import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { owns, ownerText, removeIfSame, withRecoveryGuard } from "./config-lock.js";
import { WRITER } from "./opencode-config.js";

/** A lock whose owner is known is stuck after two minutes, as in config-lock.ts. */
const STUCK_MS = 120_000;
/**
 * A lock without a readable owner.json: its writer died while creating it
 * (0.1.1 and earlier wrote owner.json in place, so a kill could leave it
 * empty). Its age is the directory's.
 */
const UNOWNED_STUCK_MS = 60_000;

export interface LockInfo {
  owner: string;
  since: string;
  /** From when Reset may clear it. */
  resetAfter: string;
}

interface Held {
  stat: Stats;
  /** owner.json as read: null when absent. */
  text: string | null;
  info: LockInfo;
}

function parseOwner(text: string | null): { plugin: string | null; createdAt: number | null; valid: boolean } {
  if (text === null) return { plugin: null, createdAt: null, valid: false };
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const plugin = typeof value.plugin === "string" ? value.plugin : null;
    const createdAt = typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) ? Date.parse(value.createdAt) : null;
    const valid = plugin !== null && createdAt !== null && Number.isInteger(value.pid) && typeof value.host === "string";
    return { plugin, createdAt, valid };
  } catch {
    return { plugin: null, createdAt: null, valid: false };
  }
}

async function held(directory: string): Promise<Held | null> {
  const stat = await lstat(directory).catch(() => null);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  const text = await ownerText(directory);
  // Not readable at all (permissions): shown, never reset, since it cannot be re-checked.
  if (text === undefined) {
    const since = new Date(stat.mtimeMs).toISOString();
    return { stat, text: null, info: { owner: "unknown", since, resetAfter: new Date(8.64e15).toISOString() } };
  }
  const owner = parseOwner(text);
  const since = owner.valid ? owner.createdAt! : stat.mtimeMs;
  const resetAfter = since + (owner.valid ? STUCK_MS : UNOWNED_STUCK_MS);
  return {
    stat,
    text,
    info: { owner: owner.plugin ?? "unknown", since: new Date(since).toISOString(), resetAfter: new Date(resetAfter).toISOString() },
  };
}

/** The lock (or its recovery guard), when it is held. */
export async function lockState(configFile: string): Promise<LockInfo | null> {
  return (await held(`${configFile}.bb-config-lock`))?.info ?? (await held(`${configFile}.bb-config-lock.recovery`))?.info ?? null;
}

/** The directory, when Reset may clear it now. */
async function stuck(directory: string): Promise<Held | null> {
  const found = await held(directory);
  if (found === null || Date.now() < Date.parse(found.info.resetAfter)) return null;
  return found;
}

/**
 * Clear a stuck lock on the user's request: one with a known owner held for
 * over two minutes, or one without a readable owner.json older than a minute.
 * A stuck recovery guard is cleared first; the lock itself is cleared only
 * while this call holds the guard, and only if it is still the same directory
 * with the same owner.json that was found stuck. Returns whether anything was
 * cleared.
 */
export async function resetStuckLock(configFile: string): Promise<boolean> {
  const lock = `${configFile}.bb-config-lock`;
  let cleared = false;
  const guard = await stuck(`${lock}.recovery`);
  if (guard !== null) cleared = await removeIfSame(`${lock}.recovery`, guard.stat, owns.text(guard.text));
  const result = await withRecoveryGuard(lock, WRITER, async () => {
    const found = await stuck(lock);
    return found === null ? false : removeIfSame(lock, found.stat, owns.text(found.text));
  });
  return cleared || result === true;
}
