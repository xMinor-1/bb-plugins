// The health check against a stub MCP server.
import { afterEach, describe, expect, it } from "vitest";
import { probeServer } from "../src/host/probe";
import { startStubMcp, type Stub } from "./stub-mcp";

const TOKEN = "tok-synthetic-probe";
const auth = { Authorization: `Bearer ${TOKEN}` };
const stubs: Stub[] = [];
const stub = async (...args: Parameters<typeof startStubMcp>) => {
  const created = await startStubMcp(...args);
  stubs.push(created);
  return created;
};
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((item) => item.close()));
});

describe("probeServer", () => {
  it("reports a working server and counts its tools (JSON answers)", async () => {
    const server = await stub({ token: TOKEN, tools: 3 });
    expect(await probeServer(server.url, auth)).toEqual({ status: "ok", detail: null, tools: 3 });
    expect(server.requests.map((request) => request.rpc ?? request.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"].slice(0, server.requests.length));
    expect(server.requests.filter((request) => request.rpc === "tools/list")[0]?.session).toBe("stub-session-1");
  });

  it("reads answers from an event stream that stays open", async () => {
    const server = await stub({ token: TOKEN, mode: "sse", tools: 5 });
    const started = Date.now();
    expect(await probeServer(server.url, auth)).toMatchObject({ status: "ok", tools: 5 });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("calls a refused token what it is", async () => {
    const server = await stub({ token: TOKEN });
    expect(await probeServer(server.url, { Authorization: "Bearer wrong" })).toEqual({ status: "unauthorized", detail: "HTTP 401", tools: null });
  });

  it("reports failures without their bodies", async () => {
    const failing = await stub({ token: null, fail: 502 });
    expect(await probeServer(failing.url, auth)).toEqual({ status: "down", detail: "HTTP 502", tools: null });
    const closed = await stub({ token: null });
    const url = closed.url;
    await closed.close();
    stubs.pop();
    expect(await probeServer(url, auth)).toMatchObject({ status: "down", detail: "connection refused" });
  });

  it("gives up after its timeout", async () => {
    const server = await stub({ token: null, hang: true });
    expect(await probeServer(server.url, auth, { timeoutMs: 300 })).toEqual({ status: "down", detail: "timeout", tools: null });
  });

  it("never follows a redirect, so the token stays with the server it belongs to", async () => {
    const elsewhere = await stub({ token: null });
    const server = await stub({ token: null, redirectTo: elsewhere.url });
    expect(await probeServer(server.url, auth)).toMatchObject({ status: "down", detail: "redirect (HTTP 302)" });
    expect(elsewhere.requests).toEqual([]);
  });
});
