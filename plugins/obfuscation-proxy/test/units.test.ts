import { describe, expect, it } from "vitest";
import { MaskMatcher, ThreadFeeds } from "../src/feed";
import { parseProxyLogLine } from "../src/log-parser";
import { ownedKeyInExtra, renderProxyConfig } from "../src/proxy-config";
import { isExternalModel, parsePrefixes, sumMasked, type FeedEntry } from "../src/shared";
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

describe("isExternalModel", () => {
  const corporate = parsePrefixes("corp-gateway/, local-");
  it("treats routed agents as external unless their model is in-network", () => {
    expect(isExternalModel("claude-code", "claude-sonnet-5-5", [])).toBe(true);
    expect(isExternalModel("claude-code", "corp-gateway/large", corporate)).toBe(false);
  });
  it("counts other agents only once in-network models are declared", () => {
    expect(isExternalModel("acp-opencode", "anthropic/claude", [])).toBe(false);
    expect(isExternalModel("acp-opencode", "anthropic/claude", corporate)).toBe(true);
    expect(isExternalModel("acp-opencode", "corp-gateway/code", corporate)).toBe(false);
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
