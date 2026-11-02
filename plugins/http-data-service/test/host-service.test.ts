// The host entry against a real local HTTP server: what it sends and what it does with each answer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataService, checkLogin } from "../src/host/service";
import { MAX_RESPONSE_BYTES, basicHeader } from "../src/host/http";
import { openFileSecretStore } from "../src/host/secret-store";

async function waitUntil(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

const PASSWORD = "pä ss\"w\\ord";
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let dir: string;
let seen: IncomingMessage[];
let respond: Handler;

beforeEach(async () => {
  seen = [];
  respond = (_req, res) => res.end('{"data":[]}');
  dir = await mkdtemp(join(tmpdir(), "data-service-"));
  server = createServer((req, res) => {
    seen.push(req);
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app/api/tools`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

function service() {
  return new DataService({ dataDir: dir, store: openFileSecretStore(join(dir, "secrets")) });
}

async function signedIn(user = "person") {
  const s = service();
  await s.saveConnection({ baseUrl: base, user, password: PASSWORD });
  return s;
}

describe("a read request", () => {
  it("sends one GET with Basic to the method's address, relative to the base", async () => {
    const s = await signedIn();
    const result = await s.request({ baseUrl: base, path: "agent/items", query: { code: "0012345678", note: "a&b=c" } });
    expect(result).toEqual({ ok: true, text: '{"data":[]}', truncated: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("/app/api/tools/agent/items?code=0012345678&note=a%26b%3Dc");
    expect(seen[0]!.headers.authorization).toBe(basicHeader("person", PASSWORD));
  });

  it("encodes a Cyrillic login and any password as UTF-8", async () => {
    const s = await signedIn("Иванов");
    await s.request({ baseUrl: base, path: "items", query: {} });
    const decoded = Buffer.from(seen[0]!.headers.authorization!.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe(`Иванов:${PASSWORD}`);
  });

  it("does not follow a redirect, so the password stays with the configured address", async () => {
    const other = createServer((_req, res) => res.end("{}"));
    const hits: IncomingMessage[] = [];
    other.on("request", (req) => hits.push(req));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    respond = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal` });
      res.end();
    };
    const s = await signedIn();
    expect(await s.request({ baseUrl: base, path: "items", query: {} })).toEqual({ ok: false, code: "redirect", status: 302, detail: null });
    expect(hits).toHaveLength(0);
    other.closeAllConnections();
    await new Promise((resolve) => other.close(resolve));
  });

  it.each([
    [403, "forbidden"],
    [404, "notFound"],
    [400, "badRequest"],
    [500, "serverError"],
  ] as const)("turns HTTP %i into %s and does not pause signing in", async (code, failure) => {
    respond = (_req, res) => {
      res.statusCode = code;
      res.end("the service's words");
    };
    const s = await signedIn();
    expect(await s.request({ baseUrl: base, path: "items", query: {} })).toEqual({ ok: false, code: failure, status: code, detail: "the service's words" });
    expect((await s.status(base)).blocked).toBe(false);
  });

  it("does not take a sign-in page with status 200 for data", async () => {
    respond = (_req, res) => res.end("<html>sign in</html>");
    const s = await signedIn();
    expect(await s.request({ baseUrl: base, path: "items", query: {} })).toMatchObject({ ok: false, code: "notJson" });
  });

  it("drops a byte order mark before JSON", async () => {
    respond = (_req, res) => res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]));
    const s = await signedIn();
    expect(await s.request({ baseUrl: base, path: "items", query: {} })).toEqual({ ok: true, text: '{"a":1}', truncated: false });
  });

  it("cuts an oversized answer and says so", async () => {
    respond = (_req, res) => res.end(`[${'"x",'.repeat(MAX_RESPONSE_BYTES)}"x"]`);
    const s = await signedIn();
    const result = await s.request({ baseUrl: base, path: "items", query: {} });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && Buffer.byteLength(result.text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("names an unreachable service", async () => {
    const s = await signedIn();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    expect(await s.request({ baseUrl: base, path: "items", query: {} })).toMatchObject({ ok: false, code: "unreachable" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  it("refuses without a sign-in and without a request", async () => {
    expect(await service().request({ baseUrl: base, path: "items", query: {} })).toMatchObject({ ok: false, code: "noPassword" });
    expect(seen).toHaveLength(0);
  });

  it("sends the password only to the address it was entered for", async () => {
    const s = await signedIn();
    expect(await s.request({ baseUrl: "https://other.example.com/api", path: "items", query: {} })).toMatchObject({ ok: false, code: "addressChanged" });
    expect(seen).toHaveLength(0);
    expect((await s.status("https://other.example.com/api")).addressChanged).toBe(true);
    expect((await s.status(base)).addressChanged).toBe(false);
  });
});

describe("a refused password", () => {
  beforeEach(() => {
    respond = (_req, res) => {
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'Basic realm="x"');
      res.end();
    };
  });

  it("pauses signing in across restarts, so the account is not locked", async () => {
    const s = await signedIn();
    expect(await s.request({ baseUrl: base, path: "items", query: {} })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await s.request({ baseUrl: base, path: "items", query: {} })).toMatchObject({ ok: false, code: "paused" });
    expect(await service().request({ baseUrl: base, path: "items", query: {} })).toMatchObject({ ok: false, code: "paused" });
    expect(seen).toHaveLength(1);
    expect((await service().status(base)).blocked).toBe(true);
  });

  it("resumes on a new password or on an explicit retry only", async () => {
    const s = await signedIn();
    await s.checkSignIn({ baseUrl: base, path: "items" });
    expect(seen).toHaveLength(1);
    await s.checkSignIn({ baseUrl: base, path: "items" });
    expect(seen).toHaveLength(1);
    await s.checkSignIn({ baseUrl: base, path: "items", retry: true });
    expect(seen).toHaveLength(2);
    respond = (_req, res) => res.end("{}");
    await s.saveConnection({ baseUrl: base, user: "person", password: "new" });
    expect((await s.status(base)).blocked).toBe(false);
    expect(await s.checkSignIn({ baseUrl: base, path: "items" })).toEqual({ ok: true, code: null, status: null });
  });
});

describe("several requests at once", () => {
  const ask = (s: DataService) => s.request({ baseUrl: base, path: "items", query: {} });
  const refuse: Handler = (_req, res) => {
    res.statusCode = 401;
    res.end();
  };

  it("try a wrong password once: the rest wait and do not reach the service", async () => {
    respond = refuse;
    const s = await signedIn();
    const results = await Promise.all(Array.from({ length: 6 }, () => ask(s)));
    expect(seen).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "unauthorized")).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "paused")).toHaveLength(5);
  });

  it("go on together once the password is accepted", async () => {
    const held: ServerResponse[] = [];
    respond = (_req, res) => void held.push(res);
    const s = await signedIn();
    const first = Promise.all(Array.from({ length: 3 }, () => ask(s)));
    await waitUntil(() => held.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held).toHaveLength(1);
    respond = (_req, res) => res.end("{}");
    held[0]!.end("{}");
    expect((await first).every((result) => result.ok)).toBe(true);
    expect(seen).toHaveLength(3);
    respond = (_req, res) => void held.push(res);
    const parallel = Promise.all([ask(s), ask(s)]);
    await waitUntil(() => held.length === 3);
    held[1]!.end("{}");
    held[2]!.end("{}");
    await parallel;
  });

  it("hand the try on when it fails for a reason other than the password", async () => {
    respond = (_req, res) => {
      res.statusCode = 503;
      res.end();
    };
    const s = await signedIn();
    const results = await Promise.all([ask(s), ask(s), ask(s)]);
    expect(results.every((result) => !result.ok && result.code === "serverError")).toBe(true);
    expect(seen).toHaveLength(3);
    expect((await s.status(base)).blocked).toBe(false);
  });

  it("a refusal of the old password does not pause the new one", async () => {
    const held: ServerResponse[] = [];
    respond = (_req, res) => void held.push(res);
    const s = await signedIn();
    const old = s.checkSignIn({ baseUrl: base, path: "items" });
    await waitUntil(() => held.length === 1);
    await s.saveConnection({ baseUrl: base, user: "person", password: "new" });
    respond = (_req, res) => res.end("{}");
    expect(await s.checkSignIn({ baseUrl: base, path: "items" })).toEqual({ ok: true, code: null, status: null });
    held[0]!.statusCode = 401;
    held[0]!.end();
    await old;
    const status = await s.status(base);
    expect(status.blocked).toBe(false);
    expect(status.lastCheck).toMatchObject({ ok: true });
  });

  it("a 401 whose body breaks off still pauses", async () => {
    respond = (_req, res) => {
      res.writeHead(401, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => res.destroy(), 10);
    };
    const s = await signedIn();
    expect(await ask(s)).toMatchObject({ ok: false, code: "unauthorized", status: 401 });
    expect((await s.status(base)).blocked).toBe(true);
  });
});

describe("the sign-in", () => {
  it("records the check without the answer", async () => {
    respond = (_req, res) => res.end('{"data":"company data"}');
    const s = await signedIn();
    expect(await s.checkSignIn({ baseUrl: base, path: "items" })).toEqual({ ok: true, code: null, status: null });
    const state = await readFile(join(dir, "state.json"), "utf8");
    expect(state).not.toContain("company data");
    expect((await s.status(base)).lastCheck).toMatchObject({ ok: true });
  });

  it("keeps the password out of the state file and removes it on sign-out", async () => {
    const s = await signedIn();
    const state = await readFile(join(dir, "state.json"), "utf8");
    expect(state).not.toContain(PASSWORD);
    expect(state).not.toContain(Buffer.from(PASSWORD, "utf8").toString("base64"));
    expect((await s.status(base)).hasPassword).toBe(true);
    const after = await s.forget(base);
    expect(after).toMatchObject({ user: null, hasPassword: false, blocked: false, lastCheck: null });
  });

  it("keeps the saved password when only the login changes", async () => {
    const s = await signedIn();
    await s.saveConnection({ baseUrl: base, user: "second" });
    await s.request({ baseUrl: base, path: "items", query: {} });
    expect(seen[0]!.headers.authorization).toBe(basicHeader("second", PASSWORD));
  });

  it("will not send a saved password to a new origin", async () => {
    const s = await signedIn();
    await expect(s.saveConnection({ baseUrl: "https://other.example.com/api", user: "person" })).rejects.toThrow(/enter the password again/);
    expect(await s.request({ baseUrl: base, path: "items", query: {} })).toMatchObject({ ok: true });
    expect((await s.status(base)).addressChanged).toBe(false);
    await s.saveConnection({ baseUrl: "https://other.example.com/api", user: "person", password: "another" });
    expect((await s.status("https://other.example.com/api")).addressChanged).toBe(false);
  });

  it("will not reuse a password left in the store by an earlier install", async () => {
    await (await signedIn()).state.update(() => ({ user: null, origin: null, blocked: false, lastCheck: null }));
    const fresh = service();
    await expect(fresh.saveConnection({ baseUrl: base, user: "person" })).rejects.toThrow(/enter the password again/);
  });

  it("refuses a login HTTP Basic cannot carry", () => {
    expect(() => checkLogin("a:b")).toThrow(/colon/);
    expect(() => checkLogin("  ")).toThrow();
    expect(checkLogin(" DOMAIN\\person ")).toBe("DOMAIN\\person");
  });
});
