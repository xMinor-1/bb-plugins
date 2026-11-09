import { describe, expect, it } from "vitest";
import { MaskMatcher, ThreadFeeds } from "../src/feed";
import { parseProxyLogLine } from "../src/log-parser";
import { ownedKeyInExtra, renderProxyConfig } from "../src/proxy-config";
import { parsePrefixes, segmentLed, segmentMode, sumMasked, type FeedEntry, type ThreadStatus } from "../src/shared";
import { memoryStorage } from "./helpers";

describe("parseProxyLogLine", () => {
  it("reads the lines the proxy writes", () => {
    expect(parseProxyLogLine('{"level":"INFO","msg":"listening","addr":"127.0.0.1:18080"}')).toEqual({
      kind: "listening",
      addr: "127.0.0.1:18080",
    });
    expect(
      parseProxyLogLine(
        '{"level":"INFO","msg":"detect.debug","run_id":"a1","in_bytes":192,"out_bytes":157,' +
          '"by_category":{"addresses":0,"internal_hosts":2,"secrets":1,"terms":1},"json_in":true,"json_out":true}',
      ),
    ).toEqual({ kind: "masks", inBytes: 192, byCategory: { internal_hosts: 2, secrets: 1, terms: 1 } });
    expect(
      parseProxyLogLine(
        '{"level":"INFO","msg":"upstream call","path":"/v1/messages","route":"anthropic","status":200,"duration_ms":63}',
      ),
    ).toEqual({ kind: "request", path: "/v1/messages", status: 200, durationMs: 63 });
  });

  it("turns errors and plain text into error events", () => {
    expect(parseProxyLogLine('{"level":"ERROR","msg":"upstream error","error":"dial tcp: refused"}')).toEqual({
      kind: "error",
      message: "upstream error: dial tcp: refused",
    });
    expect(parseProxyLogLine("Error: read config: open x: no such file")).toEqual({
      kind: "error",
      message: "Error: read config: open x: no such file",
    });
    expect(parseProxyLogLine("")).toEqual({ kind: "other" });
    expect(parseProxyLogLine('{"level":"INFO","msg":"metrics listening"}')).toEqual({ kind: "other" });
  });
});

describe("renderProxyConfig", () => {
  it("writes the listen address, upstream and JSON logs, then the extra YAML", () => {
    const text = renderProxyConfig({
      port: 41234,
      upstream: "https://api.anthropic.com/",
      extra: "obfuscation:\n  detect:\n    debug: true",
    });
    expect(text).toContain('addr: "127.0.0.1:41234"');
    expect(text).toContain('base_url: "https://api.anthropic.com"');
    expect(text).toContain('format: "json"');
    expect(text.endsWith("obfuscation:\n  detect:\n    debug: true\n")).toBe(true);
  });

  it("refuses extra YAML that redefines what the plugin owns", () => {
    expect(ownedKeyInExtra("upstream:\n  default: x")).toBe("upstream");
    expect(ownedKeyInExtra("obfuscation:\n  server: 1")).toBeNull();
    expect(() => renderProxyConfig({ port: 1, upstream: "https://a.example", extra: "server:\n  addr: x" })).toThrow(
      /must not set "server"/u,
    );
  });

  it("requires an https upstream", () => {
    expect(() => renderProxyConfig({ port: 1, upstream: "http://127.0.0.1:8080", extra: "" })).toThrow(/https/u);
  });
});

describe("segmentMode", () => {
  const corporate = parsePrefixes("corp-gateway/, local-");
  it("routes external models of agents the plugin serves", () => {
    expect(segmentMode("claude-code", "claude-sonnet-5-5", [])).toBe("routed");
    expect(segmentMode("claude-code", null, corporate)).toBe("routed");
  });
  it("marks in-network models for any agent", () => {
    expect(segmentMode("claude-code", "corp-gateway/large", corporate)).toBe("in-network");
    expect(segmentMode("acp-opencode", "local-coder", corporate)).toBe("in-network");
  });
  it("marks agents the plugin does not route as unavailable, with or without the list", () => {
    expect(segmentMode("codex", "gpt-5", [])).toBe("unavailable");
    expect(segmentMode("acp-opencode", "anthropic/claude", corporate)).toBe("unavailable");
    expect(segmentMode("codex", null, corporate)).toBe("unavailable");
  });
});

describe("segmentLed", () => {
  const status = (masking: boolean, state: ThreadStatus["proxy"]["state"]): ThreadStatus => ({
    threadId: "t",
    masking,
    explicit: false,
    proxy: { state, message: null, problem: null, since: 0 },
    totals: { requests: 0, tokenCounts: 0, masked: 0, direct: 0, errors: 0, lastAt: null },
  });
  it("is grey for in-network models and agents not routed, whatever the status", () => {
    expect(segmentLed("in-network", status(true, "running"))).toBe("idle");
    expect(segmentLed("unavailable", null)).toBe("idle");
  });
  it("follows the switch and the proxy for routed threads", () => {
    expect(segmentLed("routed", null)).toBe("loading");
    expect(segmentLed("routed", status(true, "running"))).toBe("on");
    expect(segmentLed("routed", status(false, "running"))).toBe("off");
    expect(segmentLed("routed", status(false, "failed"))).toBe("off");
    expect(segmentLed("routed", status(true, "starting"))).toBe("problem");
    expect(segmentLed("routed", status(true, "not-configured"))).toBe("problem");
  });
});

function entry(partial: Partial<FeedEntry>): FeedEntry {
  return {
    id: "e",
    at: 1,
    path: "/v1/messages",
    model: "m",
    via: "proxy",
    status: 200,
    durationMs: 5,
    masked: null,
    maskedTotal: 0,
    error: null,
    ...partial,
  };
}

describe("ThreadFeeds", () => {
  it("keeps the newest entries first, counts totals and saves them", async () => {
    const storage = memoryStorage();
    const feeds = new ThreadFeeds(storage, 2);
    for (const [index, partial] of [
      { masked: { secrets: 2, terms: 1 } },
      { via: "direct" as const },
      { status: 503, via: "blocked" as const, error: "down" },
    ].entries()) {
      const item = entry({ id: `e${index}`, at: index, ...partial });
      await feeds.start("t1", item);
      await feeds.finish("t1", item);
    }
    expect((await feeds.entries("t1")).map((item) => item.id)).toEqual(["e2", "e1"]);
    expect(await feeds.totals("t1")).toEqual({ requests: 3, tokenCounts: 0, masked: 3, direct: 1, errors: 1, lastAt: 2 });
    const reloaded = new ThreadFeeds(storage, 2);
    expect(await reloaded.totals("t1")).toEqual({ requests: 3, tokenCounts: 0, masked: 3, direct: 1, errors: 1, lastAt: 2 });
    expect(await reloaded.totals("t2")).toEqual({ requests: 0, tokenCounts: 0, masked: 0, direct: 0, errors: 0, lastAt: null });
  });
});

describe("MaskMatcher", () => {
  it("gives a report to the pending request with the same body size, oldest first", () => {
    const matcher = new MaskMatcher();
    const seen: string[] = [];
    matcher.expect(10, () => seen.push("a"));
    const forgetB = matcher.expect(20, () => seen.push("b"));
    matcher.expect(10, () => seen.push("c"));
    expect(matcher.report(10, {})).toBe(true);
    forgetB();
    expect(matcher.report(20, {})).toBe(false);
    expect(matcher.report(10, {})).toBe(true);
    expect(seen).toEqual(["a", "c"]);
    expect(matcher.size).toBe(0);
  });

  it("sums masked values", () => {
    expect(sumMasked({ a: 2, b: 3, c: -1 })).toBe(5);
    expect(sumMasked(null)).toBe(0);
  });
});

describe("ThreadFeeds and token counts", () => {
  it("tallies token counts apart from model requests and keeps them out of the list", async () => {
    const feeds = new ThreadFeeds(memoryStorage());
    const count = entry({ id: "c", path: "/v1/messages/count_tokens", masked: { secrets: 4 } });
    await feeds.start("t", count);
    await feeds.finish("t", count);
    const model = entry({ id: "m", masked: { secrets: 1 } });
    await feeds.start("t", model);
    await feeds.finish("t", model);
    expect((await feeds.entries("t")).map((item) => item.id)).toEqual(["m"]);
    expect(await feeds.totals("t")).toMatchObject({ requests: 1, tokenCounts: 1, masked: 1 });
  });
});
