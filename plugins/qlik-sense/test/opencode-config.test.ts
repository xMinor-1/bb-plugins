import { mkdtemp, readFile, writeFile, mkdir, lstat, rm, utimes } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { openCodeMajor, patchMcpConfig, writeMcpConfig, type LocalMcpEntry } from "../src/host/opencode-config.js";
import { parseAllowedProviders, urlSettingSchema } from "../src/shared/settings.js";
import { acquireConfigLock } from "../src/host/config-lock.js";

const entry: LocalMcpEntry = { type: "local", command: ["node", "--use-system-ca", "/example/qlik.mjs"], enabled: false };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function configPath() {
  const dir = await mkdtemp(join(tmpdir(), "qlik-config-test-"));
  dirs.push(dir);
  return join(dir, "opencode.json");
}

describe("OpenCode config ownership", () => {
  it("uses only the version-reported layout", () => {
    expect(openCodeMajor("2.2.5\n")).toBe(2);
    expect(openCodeMajor("1.18.3")).toBe(1);
    expect(() => openCodeMajor("3.0.0")).toThrow();
    expect(() => openCodeMajor("warning 2.2.5")).toThrow();
    expect(parse(patchMcpConfig("{}", 1, entry).text).mcp["qlik-sense"]).toEqual(entry);
    expect(parse(patchMcpConfig("{}", 2, entry).text).mcp.servers["qlik-sense"]).toEqual(entry);
  });

  it("preserves foreign settings, comments, legacy MCP and trailing commas", () => {
    const source = '{\n  // managed by fleet\n  "providers": {"example": {"secret": "fixture-only"}},\n  "mcp": {"qlik": {"enabled": true}, "servers": {"other": {"enabled": true},}},\n}\n';
    const result = patchMcpConfig(source, 2, entry);
    expect(result.text).toContain("// managed by fleet");
    expect(result.legacyEntry).toBe(true);
    const config = parse(result.text);
    delete config.mcp.servers["qlik-sense"];
    expect(config).toEqual(parse(source));
  });

  it.each(['{"mcp":null}', '{"mcp":{"servers":[]}}', '{"mcp":{},"mcp":{}}', '{broken', '[]'])("refuses ambiguous input: %s", (source) => {
    expect(() => patchMcpConfig(source, 2, entry)).toThrow();
  });

  it("backs up the exact original once and replaces only its own entry", async () => {
    const path = await configPath();
    const original = '{"model":"example/model","mcp":{"qlik":{"enabled":true}}}\n';
    await writeFile(path, original);
    const first = await writeMcpConfig(path, 2, entry);
    expect(await readFile(first.backup!, "utf8")).toBe(original);
    expect((await lstat(`${path}.bb-config-lock`).catch(() => null))).toBeNull();
    expect((await writeMcpConfig(path, 2, entry)).changed).toBe(false);
    await writeMcpConfig(path, 2, { ...entry, enabled: true });
    expect(await readFile(first.backup!, "utf8")).toBe(original);
    expect(parse(await readFile(path, "utf8")).mcp.qlik).toEqual({ enabled: true });
  });

  it("refuses a concurrent fleet writer without changing the file", async () => {
    const path = await configPath();
    await writeFile(path, "{}");
    await mkdir(`${path}.bb-config-lock`);
    await expect(writeMcpConfig(path, 2, entry, { timeoutMs: 1 })).rejects.toThrow("busy");
    expect(await readFile(path, "utf8")).toBe("{}");
  });

  it("creates a missing config with the owned entry only", async () => {
    const path = await configPath();
    expect((await writeMcpConfig(path, 2, entry)).backup).toBeNull();
    expect(parse(await readFile(path, "utf8"))).toEqual({ mcp: { servers: { "qlik-sense": entry } } });
  });
});

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

describe("fleet preconfiguration", () => {
  it("accepts explicit provider IDs and rejects broad rules", () => {
    expect(parseAllowedProviders(" x5, example x5 ")).toEqual(["x5", "example"]);
    expect(parseAllowedProviders("")).toEqual([]);
    expect(() => parseAllowedProviders("*")).toThrow();
  });
  it("accepts an unset URL or HTTPS proxy prefix without embedded credentials", () => {
    expect(urlSettingSchema.safeParse("").success).toBe(true);
    expect(urlSettingSchema.safeParse("https://qlik.example/proxy").success).toBe(true);
    for (const url of ["http://qlik.example", "https://user:pass@qlik.example", "https://qlik.example/?token=value"]) {
      expect(urlSettingSchema.safeParse(url).success).toBe(false);
    }
  });
});
