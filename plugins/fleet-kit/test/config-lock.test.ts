// Shared lock tests, copied from plugins/qlik-sense/test/opencode-config.test.ts (commit c0399a0, "shared config lock").
// Keep in sync with qlik-sense.
import { mkdtemp, readFile, writeFile, mkdir, lstat, rm, utimes } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireConfigLock } from "../src/host/config-lock.js";

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
