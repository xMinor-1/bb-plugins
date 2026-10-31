import { describe, expect, it } from "vitest";
import { appLink, normalizeBaseUrl, parseQlikLink, sheetLink } from "../src/shared/links";
import { groupModels } from "../src/shared/models";
import { createPolicy, formatRules, parseRules, PolicyError } from "../src/shared/policy";
import { resolveApp } from "../src/host/service";

describe("policy", () => {
  const policy = createPolicy(parseRules("acp-opencode corp/*\n# comment\nclaude-code claude-opus-5-5\n"));

  it("allows only listed provider and model pairs", () => {
    expect(policy.allows("acp-opencode", "corp/large")).toBe(true);
    expect(policy.allows("claude-code", "claude-opus-5-5")).toBe(true);
    expect(policy.allows("acp-opencode", "opencode/free-model")).toBe(false);
    expect(policy.allows("acp-opencode", "corp-copilot/large")).toBe(false);
    expect(policy.allows("acp-cursor", "corp/large")).toBe(false);
    expect(policy.allows("claude-code", "claude-sonnet-5-5")).toBe(false);
  });

  it("refuses an unknown model and an empty rule list", () => {
    expect(policy.allows("acp-opencode", null)).toBe(false);
    expect(policy.allows(null, "corp/large")).toBe(false);
    expect(createPolicy([]).allows("acp-opencode", "corp/large")).toBe(false);
  });

  it("treats regex characters in globs literally", () => {
    const literal = createPolicy(parseRules("p a.b/*"));
    expect(literal.allows("p", "a.b/x")).toBe(true);
    expect(literal.allows("p", "aXb/x")).toBe(false);
  });

  it("rejects malformed lines and provider wildcards", () => {
    expect(() => parseRules("acp-opencode")).toThrow(PolicyError);
    expect(() => parseRules("acp-opencode a b")).toThrow(PolicyError);
    expect(() => parseRules("* corp/*")).toThrow(PolicyError);
    expect(() => parseRules("acp-opencode corp/$(x)")).toThrow(PolicyError);
  });

  it("round-trips and drops duplicates", () => {
    const rules = parseRules("a b/*\na b/*\nc d");
    expect(formatRules(rules)).toBe("a b/*\nc d");
  });
});

describe("links", () => {
  it("normalizes what people paste as the address", () => {
    expect(normalizeBaseUrl("qlik.example.com")).toBe("https://qlik.example.com/");
    expect(normalizeBaseUrl("https://qlik.example.com/hub/stream/mywork")).toBe("https://qlik.example.com/");
    expect(normalizeBaseUrl("https://qlik.example.com/corp/sense/app/1/sheet/2")).toBe("https://qlik.example.com/corp/");
    expect(normalizeBaseUrl("https://qlik.example.com/corp/")).toBe("https://qlik.example.com/corp/");
    expect(() => normalizeBaseUrl("ftp://qlik.example.com")).toThrow();
  });

  it("builds app and sheet links under a virtual proxy", () => {
    expect(sheetLink("https://q.example/corp/", "app 1", "s1")).toBe("https://q.example/corp/sense/app/app%201/sheet/s1/state/analysis");
    expect(appLink("https://q.example/", "a")).toBe("https://q.example/sense/app/a/overview");
  });

  it("reads app and sheet ids from browser links", () => {
    expect(parseQlikLink("https://q.example/corp/sense/app/abc-1/sheet/xyz/state/analysis")).toEqual({
      appId: "abc-1",
      sheetId: "xyz",
      origin: "https://q.example",
    });
    expect(parseQlikLink("https://q.example/sense/app/abc-1/overview")).toEqual({ appId: "abc-1", sheetId: null, origin: "https://q.example" });
    expect(parseQlikLink("https://q.example/single/?appid=abc&sheet=s9&opt=ctxmenu")).toEqual({
      appId: "abc",
      sheetId: "s9",
      origin: "https://q.example",
    });
    expect(parseQlikLink("https://q.example/hub/stream/mywork")).toBeNull();
    expect(parseQlikLink("not a link")).toBeNull();
  });
});

describe("model groups", () => {
  it("groups routed models under one prefix rule and keeps plain ids", () => {
    const groups = groupModels([
      { id: "corp/large", displayName: "Corp/large" },
      { id: "corp/small", displayName: "Corp/small" },
      { id: "opencode/free", displayName: "OpenCode/Free" },
      { id: "claude-opus-5-5", displayName: "Opus 5.5" },
    ]);
    expect(groups).toEqual([
      { pattern: "corp/*", label: "Corp", models: ["corp/large", "corp/small"] },
      { pattern: "opencode/*", label: "OpenCode", models: ["opencode/free"] },
      { pattern: "claude-opus-5-5", label: "Opus 5.5", models: ["claude-opus-5-5"] },
    ]);
  });
});

describe("resolveApp", () => {
  const app = (id: string, name: string) => ({ id, name, stream: null, note: "", sheets: [] });
  const catalog = { apps: [app("a1", "Sales"), app("a2", "Sales forecast"), app("a3", "Stock")] };

  it("finds an enabled app by id, exact name or a unique part", () => {
    expect(resolveApp(catalog, "a3").id).toBe("a3");
    expect(resolveApp(catalog, "sales").id).toBe("a1");
    expect(resolveApp(catalog, "forecast").id).toBe("a2");
    expect(resolveApp({ apps: [app("only", "Only")] }, undefined).id).toBe("only");
  });

  it("refuses apps outside the catalog and ambiguous names", () => {
    expect(() => resolveApp(catalog, "secret-app")).toThrow(/not enabled for agents/);
    expect(() => resolveApp(catalog, "s")).toThrow(/matches several/);
    expect(() => resolveApp(catalog, undefined)).toThrow(/Several apps are enabled/);
    expect(() => resolveApp({ apps: [] }, "a1")).toThrow(/No Qlik Sense reports are enabled/);
  });
});
