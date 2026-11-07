import { describe, expect, it } from "vitest";
import { MaskMatcher, ThreadFeeds } from "../src/feed";
import { forwardRequest, type ForwardDeps, type ProxyTarget } from "../src/forward";
import { KEY_HEADER, THREAD_HEADER } from "../src/shared";
import { memoryStorage } from "./helpers";

const KEY = "k".repeat(48);

interface Call {
  url: string;
  headers: Headers;
  body: string;
}

function setup(options: { masking: boolean; proxy?: ProxyTarget; fail?: boolean }) {
  const calls: Call[] = [];
  const masks = new MaskMatcher();
  const feeds = new ThreadFeeds(memoryStorage());
  const changes: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = new TextDecoder().decode(init?.body as Uint8Array);
    calls.push({ url: String(input), headers: new Headers(init?.headers), body });
    if (options.fail) throw new Error("connect ECONNREFUSED");
    // The proxy reports its masking while it handles the request.
    masks.report(new TextEncoder().encode(body).byteLength, { secrets: 1, internal_hosts: 2 });
    return new Response("event: message_stop\ndata: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "x-request-id": "r1" },
    });
  }) as typeof fetch;
  const deps: ForwardDeps = {
    key: KEY,
    upstream: "https://api.anthropic.com/",
    isMasking: async () => options.masking,
    proxy: () => options.proxy ?? { url: "http://127.0.0.1:40001" },
    feeds,
    masks,
    changed: (threadId) => changes.push(threadId),
    fetch: fakeFetch,
    now: () => 1000,
  };
  return { calls, feeds, changes, deps };
}

function agentRequest(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:38896/api/v1/plugins/obfuscation-proxy/http/v1/messages?beta=true", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer claude-login",
      "accept-encoding": "gzip, br",
      [KEY_HEADER]: KEY,
      [THREAD_HEADER]: "thr_1",
      ...headers,
    },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "api.corp.example" }] }),
  });
}

describe("forwardRequest", () => {
  it("refuses requests without the routing key", async () => {
    const { calls, deps } = setup({ masking: true });
    const response = await forwardRequest(agentRequest({ [KEY_HEADER]: "wrong" }), "/v1/messages", deps);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("sends a masked thread's request through the proxy and records what was masked", async () => {
    const { calls, feeds, changes, deps } = setup({ masking: true });
    const response = await forwardRequest(agentRequest(), "/v1/messages", deps);
    expect(await response.text()).toBe("event: message_stop\ndata: {}\n\n");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("r1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:40001/v1/messages?beta=true");
    expect(call.headers.get("authorization")).toBe("Bearer claude-login");
    expect(call.headers.get("accept-encoding")).toBe("identity");
    expect(call.headers.get(KEY_HEADER)).toBeNull();
    expect(call.headers.get(THREAD_HEADER)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [item] = await feeds.entries("thr_1");
    expect(item).toMatchObject({
      via: "proxy",
      status: 200,
      model: "claude-sonnet-5-5",
      masked: { secrets: 1, internal_hosts: 2 },
      maskedTotal: 3,
    });
    expect(await feeds.totals("thr_1")).toMatchObject({ requests: 1, masked: 3, direct: 0, errors: 0 });
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it("sends an unmasked thread's request straight to the upstream", async () => {
    const { calls, feeds, deps } = setup({ masking: false });
    const response = await forwardRequest(agentRequest(), "/v1/messages", deps);
    await response.text();
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [item] = await feeds.entries("thr_1");
    expect(item).toMatchObject({ via: "direct", masked: null, maskedTotal: 0 });
    expect(await feeds.totals("thr_1")).toMatchObject({ requests: 1, direct: 1 });
  });

  it("sends nothing when masking is on and the proxy is down", async () => {
    const { calls, feeds, deps } = setup({ masking: true, proxy: { error: "it exited with code 1" } });
    const response = await forwardRequest(agentRequest(), "/v1/messages", deps);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Nothing was sent");
    expect(calls).toHaveLength(0);
    const [item] = await feeds.entries("thr_1");
    expect(item).toMatchObject({ via: "blocked", status: 503, error: "it exited with code 1" });
  });

  it("reports an unreachable target as a 502 in the API's error shape", async () => {
    const { feeds, deps } = setup({ masking: true, fail: true });
    const response = await forwardRequest(agentRequest(), "/v1/messages", deps);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { type: string }).type).toBe("error");
    expect(await feeds.totals("thr_1")).toMatchObject({ requests: 1, errors: 1 });
  });
});
