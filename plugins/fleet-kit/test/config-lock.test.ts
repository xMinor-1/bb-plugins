// Lock tests. The first block started as a copy of qlik-sense's tests (commit
// c0399a0); Qlik no longer writes opencode.json, so they evolve here.
import { mkdtemp, readFile, readdir, writeFile, mkdir, lstat, rm, utimes } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireConfigLock, owns, removeIfSame, withRecoveryGuard } from "../src/host/config-lock.js";
import { lockState, resetStuckLock } from "../src/host/lock-state.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function configPath() {
  const dir = await mkdtemp(join(tmpdir(), "fleet-kit-lock-test-"));
  dirs.push(dir);
  return join(dir, "opencode.json");
}

describe("shared config lock", () => {
  it("records its owner, waits for a live writer, and releases idempotently", async () => {
    const path = await configPath();
    const release = await acquireConfigLock(path, "fleet-kit");
    const owner = JSON.parse(await readFile(`${path}.bb-config-lock/owner.json`, "utf8"));
    // Written whole through a temporary file, which is gone afterwards.
    expect(await readdir(`${path}.bb-config-lock`)).toEqual(["owner.json"]);
    expect(owner).toMatchObject({ plugin: "fleet-kit", pid: process.pid, host: hostname() });
    await expect(acquireConfigLock(path, "qlik-sense", { timeoutMs: 1 })).rejects.toThrow("fleet-kit since");
    const waiting = acquireConfigLock(path, "qlik-sense");
    await release();
    await release();
    const nextRelease = await waiting;
    await nextRelease();
  });

  it.each(["dead", "missing"])("recovers an old %s owner", async (kind) => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await mkdir(lock);
    const old = new Date(Date.now() - 120_000);
    if (kind === "dead") await writeFile(`${lock}/owner.json`, JSON.stringify({ plugin: "fleet-kit", pid: 2147483647, host: hostname(), createdAt: old.toISOString() }));
    await utimes(lock, old, old);
    const release = await acquireConfigLock(path, "qlik-sense", { timeoutMs: 1 });
    await release();
    expect(await lstat(lock).catch(() => null)).toBeNull();
  });

  it.each(["live", "foreign"])("keeps an old %s owner", async (kind) => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await mkdir(lock);
    const old = new Date(Date.now() - 120_000);
    await writeFile(`${lock}/owner.json`, JSON.stringify({ plugin: "fleet-kit", pid: kind === "live" ? process.pid : 2147483647, host: kind === "live" ? hostname() : "other-host.example", createdAt: old.toISOString() }));
    await utimes(lock, old, old);
    await expect(acquireConfigLock(path, "qlik-sense", { timeoutMs: 1 })).rejects.toThrow("fleet-kit since");
    expect((await lstat(lock)).isDirectory()).toBe(true);
  });

  it("cancels waiting without removing another writer's lock", async () => {
    const path = await configPath();
    const release = await acquireConfigLock(path, "fleet-kit");
    await expect(acquireConfigLock(path, "qlik-sense", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect((await lstat(`${path}.bb-config-lock`)).isDirectory()).toBe(true);
    await release();
  });

  it("serializes competing stale recoverers and never overlaps owners", async () => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await mkdir(lock);
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const release = await acquireConfigLock(path, `writer-${index}`);
      active++;
      peak = Math.max(peak, active);
      const owner = JSON.parse(await readFile(`${lock}/owner.json`, "utf8"));
      expect(owner.plugin).toBe(`writer-${index}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      await release();
    }));
    expect(peak).toBe(1);
  });

  it("preserves a recovery guard instead of recursively recovering it", async () => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await mkdir(lock);
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await mkdir(`${lock}.recovery`);
    await expect(acquireConfigLock(path, "qlik-sense", { timeoutMs: 1 })).rejects.toThrow("busy");
    expect((await lstat(`${lock}.recovery`)).isDirectory()).toBe(true);
  });
});

describe("removing only what is ours", () => {
  it("leaves a directory that replaced the one it checked", async () => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await mkdir(lock);
    const mine = await lstat(lock);
    await rm(lock, { recursive: true });
    await mkdir(lock);
    const theirs = JSON.stringify({ plugin: "other", pid: 1, host: "h", createdAt: new Date().toISOString(), token: "theirs" });
    await writeFile(`${lock}/owner.json`, theirs);
    // The file system may hand out the same inode at once; the owner decides.
    expect(await removeIfSame(lock, mine, owns.nobody)).toBe(false);
    expect(await removeIfSame(lock, mine, owns.token("mine"))).toBe(false);
    expect(await readFile(`${lock}/owner.json`, "utf8")).toBe(theirs);
  });

  it("does not release a guard another process put in its place", async () => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    const result = await withRecoveryGuard(lock, "fleet-kit", async () => {
      await rm(`${lock}.recovery`, { recursive: true });
      await mkdir(`${lock}.recovery`);
      await writeFile(`${lock}.recovery/owner.json`, JSON.stringify({ plugin: "other", pid: 1, host: "h", createdAt: new Date().toISOString(), token: "theirs" }));
      return "done";
    });
    expect(result).toBe("done");
    expect(JSON.parse(await readFile(`${lock}.recovery/owner.json`, "utf8")).token).toBe("theirs");
    expect(await withRecoveryGuard(lock, "fleet-kit", async () => "never")).toBeNull();
  });
});

describe("manual lock reset", () => {
  const stale = async (directory: string, minutes: number) => {
    await mkdir(directory);
    const at = new Date(Date.now() - minutes * 60_000);
    await writeFile(`${directory}/owner.json`, JSON.stringify({ plugin: "fleet-kit", pid: 2147483647, host: hostname(), createdAt: at.toISOString() }));
    await utimes(directory, at, at);
  };

  it("keeps a fresh lock and clears one stuck for minutes", async () => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await stale(lock, 0);
    expect(await resetStuckLock(path)).toBe(false);
    expect((await lstat(lock)).isDirectory()).toBe(true);
    await rm(lock, { recursive: true });
    await stale(lock, 5);
    expect(await resetStuckLock(path)).toBe(true);
    expect(await lstat(lock).catch(() => null)).toBeNull();
    expect(await lstat(`${lock}.recovery`).catch(() => null)).toBeNull();
  });

  it("does not touch the lock while another process holds a fresh guard", async () => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await stale(lock, 5);
    await stale(`${lock}.recovery`, 0);
    expect(await resetStuckLock(path)).toBe(false);
    expect((await lstat(lock)).isDirectory()).toBe(true);
    expect((await lstat(`${lock}.recovery`)).isDirectory()).toBe(true);
  });

  it.each([["empty", ""], ["truncated", '{"plugin":"fleet-'], ["without a pid", '{"plugin":"fleet-kit","host":"h","createdAt":"2026-10-31T10:00:00Z"}']])(
    "clears a lock whose owner.json is %s once the directory is over a minute old",
    async (_, text) => {
      const path = await configPath();
      const lock = `${path}.bb-config-lock`;
      await mkdir(lock);
      await writeFile(`${lock}/owner.json`, text);
      const recent = new Date(Date.now() - 30_000);
      await utimes(lock, recent, recent);
      expect(await resetStuckLock(path)).toBe(false);
      expect((await lstat(lock)).isDirectory()).toBe(true);
      expect(await lockState(path)).toMatchObject({ since: recent.toISOString(), resetAfter: new Date(recent.getTime() + 60_000).toISOString() });

      const old = new Date(Date.now() - 61_000);
      await utimes(lock, old, old);
      expect(await resetStuckLock(path)).toBe(true);
      expect(await lstat(lock).catch(() => null)).toBeNull();
      expect(await lstat(`${lock}.recovery`).catch(() => null)).toBeNull();
    },
  );

  it("clears a guard left with an empty owner.json, then the lock", async () => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await stale(lock, 5);
    await mkdir(`${lock}.recovery`);
    await writeFile(`${lock}.recovery/owner.json`, "");
    const old = new Date(Date.now() - 61_000);
    await utimes(`${lock}.recovery`, old, old);
    expect(await resetStuckLock(path)).toBe(true);
    expect(await lstat(lock).catch(() => null)).toBeNull();
    expect(await lstat(`${lock}.recovery`).catch(() => null)).toBeNull();
  });

  it("clears a guard stuck for minutes, then the lock under its own guard", async () => {
    const path = await configPath();
    const lock = `${path}.bb-config-lock`;
    await stale(lock, 5);
    await stale(`${lock}.recovery`, 5);
    expect(await resetStuckLock(path)).toBe(true);
    expect(await lstat(lock).catch(() => null)).toBeNull();
    expect(await lstat(`${lock}.recovery`).catch(() => null)).toBeNull();
  });
});
