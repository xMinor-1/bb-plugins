// The host entry: the key stays in the OS store, goes in the configured header, to
// the configured address only, and never follows a redirect.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RequestInput } from "../contract";
import { requestUrl, TrackerHost } from "../src/host/service";
import { MOCK_KEY, startMockTracker } from "./fixtures/mock-tracker";
import { memoryStore } from "./memory-store";

let mock: Awaited<ReturnType<typeof startMockTracker>>;
beforeAll(async () => {
  mock = await startMockTracker();
});
afterAll(() => mock.close());

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const auth = { header: "X-API-Key", format: "{key}" };
const input = (patch: Partial<RequestInput> = {}): RequestInput => ({ baseUrl: mock.url, auth, method: "GET", path: "/auth/me", query: {}, body: null, headers: {}, exposeHeaders: [], ...patch });

async function host() {
  const store = memoryStore();
  const dataDir = await mkdtemp(join(tmpdir(), "tb-host-"));
  dirs.push(dataDir);
  return { service: new TrackerHost({ dataDir, store }), store };
}

describe("tracker host", () => {
  it("answers noKey until a key is saved, then signs requests with it", async () => {
    const { service, store } = await host();
    expect(await service.request(input())).toMatchObject({ ok: false, code: "noKey" });
    const status = await service.saveKey({ baseUrl: mock.url, key: ` ${MOCK_KEY} ` });
    expect(status).toMatchObject({ hasKey: true, keyStore: "file", addressChanged: false });
    expect([...store.values.values()][0]).not.toContain(MOCK_KEY);
    const answer = await service.request(input());
    expect(answer.ok).toBe(true);
    expect(mock.state.requests.at(-1)?.key).toBe(MOCK_KEY);
  });

  it("does not send the key to another address", async () => {
    const { service } = await host();
    await service.saveKey({ baseUrl: mock.url, key: MOCK_KEY });
    const before = mock.state.requests.length;
    expect(await service.request(input({ baseUrl: "https://elsewhere.example.com/api" }))).toMatchObject({ ok: false, code: "addressChanged" });
    expect(await service.request(input({ path: "//elsewhere.example.com/x" }))).toMatchObject({ ok: false, code: "badAddress" });
    expect(mock.state.requests.length).toBe(before);
    expect((await service.status("https://elsewhere.example.com")).addressChanged).toBe(true);
  });

  it("keeps the configuration from replacing the key's header", async () => {
    const { service } = await host();
    await service.saveKey({ baseUrl: mock.url, key: MOCK_KEY });
    await service.request(input({ headers: { "x-api-key": "other", Cookie: "a=b", "X-Org": "7" } }));
    expect(mock.state.requests.at(-1)?.key).toBe(MOCK_KEY);
  });

  it("reports a refused key, a redirect and a tracker error by code", async () => {
    const { service } = await host();
    await service.saveKey({ baseUrl: mock.url, key: "wrong" });
    expect(await service.request(input())).toMatchObject({ ok: false, code: "unauthorized", status: 401 });
    await service.saveKey({ baseUrl: mock.url, key: MOCK_KEY });
    const base = mock.url.replace(/\/api\/v1$/, "");
    expect(await service.request(input({ baseUrl: base, path: "/redirect" }))).toMatchObject({ ok: false, code: "redirect", status: 302 });
    expect(await service.request(input({ path: "/issues/NOPE-1" }))).toMatchObject({ ok: false, code: "notFound", status: 404 });
  });

  it("sends a JSON body and forgets the key", async () => {
    const { service } = await host();
    await service.saveKey({ baseUrl: mock.url, key: MOCK_KEY });
    const answer = await service.request(input({ method: "POST", path: "/issues/_search", body: JSON.stringify({ query: "queue = OPS", limit: 10, offset: 0 }) }));
    expect(answer.ok && JSON.parse(answer.text).data.issues[0].key).toBe("OPS-1");
    expect((await service.forget(mock.url)).hasKey).toBe(false);
    expect(await service.request(input())).toMatchObject({ ok: false, code: "noKey" });
  });

  it("keeps request paths under the address", () => {
    expect(requestUrl("https://t.example.com/api/v1", "/issues/A-1", { x: "1 2" })).toBe("https://t.example.com/api/v1/issues/A-1?x=1+2");
    expect(() => requestUrl("https://t.example.com/api", "//evil.example.com/x", {})).toThrow();
    expect(() => requestUrl("https://t.example.com/api", "x", {})).toThrow();
  });
});
