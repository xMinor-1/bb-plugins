// Sign-in behaviour that needs no engine: the refusal guard that must survive
// worker restarts, login validation, and where the password is kept.
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QlikService } from "../src/host/service";
import { startMockProxy, type MockProxy } from "./helpers/mock-proxy";

const USER = "CORP\\tester";

describe("sign-in guard", () => {
  let proxy: MockProxy;
  let dataDir: string;

  beforeAll(async () => {
    proxy = await startMockProxy({ engineUrl: null, user: USER, password: "right" });
    dataDir = await mkdtemp(join(tmpdir(), "qlik-sense-test-"));
  });
  afterAll(() => proxy.close());

  it("refuses a login without a domain before contacting Qlik", async () => {
    const service = new QlikService({ dataDir });
    await expect(service.saveConnection({ url: proxy.url, user: "tester", password: "x" })).rejects.toThrow(/no domain/);
    expect(proxy.stats.logins + proxy.stats.failedLogins).toBe(0);
  });

  it("stops after a refused password, even in a new worker", async () => {
    const first = new QlikService({ dataDir });
    await first.saveConnection({ url: proxy.url, user: USER, password: "wrong" });
    const check = await first.checkSignIn(false);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/did not accept the login or password/);
    expect(check.message).not.toMatch(/wrong/);
    expect(proxy.stats.failedLogins).toBe(1);
    first.close();

    // A fresh service on the same data directory is what a restarted host worker sees.
    const second = new QlikService({ dataDir });
    expect((await second.status()).blocked).toMatch(/did not accept/);
    const again = await second.checkSignIn(false);
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/Not signing in again/);
    await second.saveCatalog({ apps: [{ id: "a1", name: "Sales", stream: null, note: "", sheets: [] }] });
    const tool = await second.tool({ tool: "sheets" });
    expect(tool.isError).toBe(true);
    expect(tool.text).toMatch(/Not signing in again/);
    expect(proxy.stats.failedLogins).toBe(1);
    second.close();
  });

  it("a new password clears the guard", async () => {
    const service = new QlikService({ dataDir });
    const status = await service.saveConnection({ url: proxy.url, user: USER, password: "right" });
    expect(status.blocked).toBeNull();
    expect(status.hasPassword).toBe(true);
    await service.checkSignIn(false);
    expect(proxy.stats.logins).toBeGreaterThanOrEqual(1);
    expect(proxy.stats.failedLogins).toBe(1);
    service.close();
  });

  it("keeps the password out of the state file", async () => {
    const state = await readFile(join(dataDir, "state.json"), "utf8");
    expect(state).not.toMatch(/right/);
    if (process.platform !== "win32") {
      expect((await stat(join(dataDir, "password"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dataDir, "state.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("forget removes the connection and the password", async () => {
    const service = new QlikService({ dataDir });
    const status = await service.forget();
    expect(status).toMatchObject({ url: null, user: null, hasPassword: false, catalogApps: 0 });
    const tool = await service.tool({ tool: "reports" });
    expect(tool.text).toMatch(/not set up on this machine/);
  });
});
