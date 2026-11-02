// Parsing the build's configuration: what a method may name and what an agent may pass.
import { describe, expect, it } from "vitest";
import { buildQuery, MAX_QUERY_VALUE, methodsText, methodUrl, normalizeBaseUrl, parseMethods, type ServiceMethod } from "../src/shared/service-config";

const method: ServiceMethod = {
  name: "items",
  path: "agent/items",
  summary: "Items",
  reference: "",
  params: [
    { name: "code", type: "string", required: true, description: "Item code" },
    { name: "limit", type: "integer", min: 1, max: 500, description: "" },
    { name: "closed", type: "boolean", description: "" },
    { name: "from", type: "date", description: "" },
    { name: "tags", type: "list", description: "" },
  ],
};

describe("parseMethods", () => {
  it("reads a list and fills the defaults", () => {
    expect(parseMethods('[{"name":"a","path":"x/a","summary":"A"}]')).toEqual([{ name: "a", path: "x/a", summary: "A", params: [], reference: "" }]);
    expect(parseMethods("  ")).toEqual([]);
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["a full address", '[{"name":"a","path":"https://evil.example.com/a","summary":"A"}]', /relative/],
    ["a parent path", '[{"name":"a","path":"../a","summary":"A"}]', /relative/],
    ["a protocol-relative path", '[{"name":"a","path":"//evil.example.com/a","summary":"A"}]', /relative/],
    ["a query in the path", '[{"name":"a","path":"a?x=1","summary":"A"}]', /relative/],
    ["a repeated name", '[{"name":"a","path":"a","summary":"A"},{"name":"a","path":"b","summary":"B"}]', /repeats/],
    ["an HTTP verb", '[{"name":"a","path":"a","summary":"A","verb":"POST"}]', /invalid/],
  ])("refuses %s", (_name, text, pattern) => {
    expect(() => parseMethods(text)).toThrow(pattern);
  });
});

describe("normalizeBaseUrl and methodUrl", () => {
  it("adds one slash, keeps the path", () => {
    expect(normalizeBaseUrl("https://svc.example.com/app/api/tools/")).toBe("https://svc.example.com/app/api/tools/");
    expect(methodUrl("https://svc.example.com/app/api/tools", "agent/items", { a: "б в" })).toBe("https://svc.example.com/app/api/tools/agent/items?a=%D0%B1%20%D0%B2");
  });

  it.each(["http://svc.example.com", "https://user:pw@svc.example.com", "https://svc.example.com?a=1", "ftp://svc.example.com", "not an address"])("refuses %s", (value) => {
    expect(() => normalizeBaseUrl(value)).toThrow();
  });

  it("allows plain http only on this machine", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x/");
  });
});

describe("buildQuery", () => {
  it("passes declared parameters", () => {
    expect(buildQuery(method, { code: "0012", limit: 10, closed: true, from: "2026-01-02", tags: ["a", "b c"] })).toEqual({
      code: "0012",
      limit: "10",
      closed: "true",
      from: "2026-01-02",
      tags: "a,b c",
    });
  });

  it("takes one value without the list, and a whole number as a string", () => {
    expect(buildQuery(method, { code: "x", tags: "one tag", limit: "7" })).toEqual({ code: "x", tags: "one tag", limit: "7" });
  });

  it.each([
    ["a missing required parameter", {}, /needs the parameter "code"/],
    ["an unknown parameter", { code: "x", secret: "y" }, /no parameter "secret"/],
    ["a number for a string, which loses leading zeros", { code: 12 }, /non-empty string/],
    ["a limit above the maximum", { code: "x", limit: 501 }, /maximum is 500/],
    ["a limit below the minimum", { code: "x", limit: 0 }, /minimum is 1/],
    ["a fraction", { code: "x", limit: 1.5 }, /whole number/],
    ["a loose date", { code: "x", from: "02.01.2026" }, /YYYY-MM-DD/],
    ["a loose boolean", { code: "x", closed: "yes" }, /true or false/],
    ["an empty list", { code: "x", tags: [] }, /non-empty/],
    ["a list value with a comma, which would split in two", { code: "x", tags: ["Contract, draft"] }, /contains a comma/],
    ["one value with a comma", { code: "x", tags: "a,b" }, /contains a comma/],
    ["a number too large to stay exact", { code: "x", limit: 2 ** 53 }, /whole number/],
    ["a list longer than the host accepts", { code: "x", tags: Array.from({ length: 200 }, () => "x".repeat(30)) }, /too long/],
    ["a string longer than the host accepts", { code: "x".repeat(MAX_QUERY_VALUE + 1) }, /too long/],
  ])("refuses %s", (_name, params, pattern) => {
    expect(() => buildQuery(method, params as never)).toThrow(pattern);
  });
});

describe("methodsText", () => {
  it("lists methods with their parameters", () => {
    const text = methodsText([method]);
    expect(text).toContain("- items: Items");
    expect(text).toContain("code (string, required): Item code");
    expect(text).toContain("limit (integer, optional, min 1, max 500)");
  });
});
