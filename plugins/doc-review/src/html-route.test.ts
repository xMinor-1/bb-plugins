import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import plugin from "../server";

it("reuses one version, compresses it, and reloads changed versions", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(299999);
  const db = new DatabaseSync(":memory:");
  Object.assign(db, { name: path.resolve("../../../../.tmp/doc-review-dev/route-test.db") });
  const dispose: Array<() => void> = [];
  const routes = new Map<string, (context: any) => Promise<Response>>();
  let handlers: any;
  let version = "v1";
  const call = vi.fn(async () => version);
  const read = vi.fn(async () => ({ content: "<html><body>" + version + "x".repeat(10000) + "</body></html>", contentEncoding: "utf8", sizeBytes: 10030 }));
  const bb = {
    pluginId: "doc-review", onDispose: (fn: () => void) => dispose.push(fn),
    storage: { database: () => db, migrate: (_db: unknown, statements: string[]) => statements.forEach((s) => db.exec(s)) },
    settings: { define: () => ({ get: async () => ({ rememberRecents: true, libreOfficePath: "", chromePath: "" }) }) },
    hosts: { experimental_client: () => ({ call, experimental_onSignal: vi.fn(() => vi.fn()), experimental_onWorkerExit: vi.fn(() => vi.fn()) }) },
    sdk: { subscribe: vi.fn(() => vi.fn()), hosts: { get: vi.fn(async () => ({ status: "connected" })) }, system: { config: async () => ({ primaryHostId: "server" }) }, files: { read, createPreview: vi.fn(async () => ({ baseUrl: "/preview/fixture/" })) } },
    http: { route: (_method: string, route: string, handler: any) => routes.set(route, handler) },
    rpc: { register: (_contract: unknown, registered: any) => { handlers = registered; } },
    cli: { register: vi.fn() }, log: { warn: vi.fn() },
  } as unknown as BbPluginApi;
  try {
    await plugin(bb);
    const open = () => handlers["doc.open"]({ path: "/report.html", source: { kind: "host", experimental_hostId: "remote", threadId: null, environmentId: null, projectId: null } });
    const first = await open();
    expect(first.doc.htmlUrl).toContain("v=v1");
    const get = (wanted: string, encoding = "gzip") => routes.get("/html")!({ req: { query: (key: string) => key === "doc" ? first.doc.id : wanted, header: () => encoding }, text: (s: string, status: number) => new Response(s, { status }) });
    const [a, b] = await Promise.all([get("v1"), get("v1")]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(a.headers.get("content-encoding")).toBe("gzip");
    expect(a.headers.get("content-security-policy")).toContain("sandbox");
    const compressed = Buffer.from(await a.arrayBuffer());
    const original = gunzipSync(compressed).toString();
    expect(original).toContain("v1");
    expect(original).toContain("data-doc-review-bridge");
    expect((await b.arrayBuffer()).byteLength).toBe(compressed.length);
    const plain = await get("v1", "gzip;q=0");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(original);
    clock.mockReturnValue(300001);
    expect(await (await get("v1", "identity")).text()).toBe(original);
    expect(read).toHaveBeenCalledTimes(1);
    version = "v2";
    const hostChanged = (bb.sdk.subscribe as ReturnType<typeof vi.fn>).mock.calls.find(([arg]) => arg.event === "host:changed")![0];
    hostChanged.callback();
    expect((await open()).doc.htmlUrl).toContain("v=v2");
    const changed = await get("v2", "identity");
    expect(await changed.text()).toContain("v2");
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
    dispose.forEach((fn) => fn());
    db.close();
  }
});
