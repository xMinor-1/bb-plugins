// The pieces that do not talk to anything: field paths, request templates, the API
// profile, the plugin's issue shape, templates and board sources.
import { describe, expect, it } from "vitest";
import { parseSource } from "../src/server/board";
import { fillJson, fillPath, fillQuery, getPath, scalar } from "../src/shared/json-path";
import { boardCards, findKey, issueFrom, splitPrefix } from "../src/shared/model";
import { categoryOf, normalizeBaseUrl, parseProfile } from "../src/shared/profile";
import { childTitle, expandLabel, mergeTemplates, parseTemplates, planRows } from "../src/shared/templates";
import { MOCK_PROFILE, MOCK_TEMPLATES } from "./fixtures/mock-tracker";

const profile = parseProfile(JSON.stringify(MOCK_PROFILE));

describe("field paths", () => {
  it("reads nested fields, maps arrays and tries alternatives", () => {
    const value = { a: { b: [{ n: "x" }, { n: "y" }] }, c: null, d: "d" };
    expect(getPath(value, "a.b[].n")).toEqual(["x", "y"]);
    expect(getPath(value, "c|d")).toBe("d");
    expect(getPath(value, "missing|a.b[].n")).toEqual(["x", "y"]);
    expect(getPath(value, "")).toBe(value);
    expect(getPath({ __proto__: { evil: 1 } }, "evil")).toBeUndefined();
  });

  it("unwraps keys given as objects", () => {
    expect(scalar({ value: "PAY-1" })).toBe("PAY-1");
    expect(scalar({ key: { value: "PAY-2" } })).toBe("PAY-2");
    expect(scalar({ code: "open", name: "Open" })).toBe("open");
    expect(scalar(7)).toBe("7");
    expect(scalar("")).toBeNull();
  });
});

describe("request templates", () => {
  it("keeps a variable's type and drops what is missing", () => {
    const body = fillJson({ summary: "{summary}", labels: "{labels}", priority: "{priority}", nested: { at: "x-{key}" }, list: ["{a}", "{b}"] }, { summary: "S", labels: ["l1", "l2"], key: "K-1", a: 1 });
    expect(body).toEqual({ summary: "S", labels: ["l1", "l2"], nested: { at: "x-K-1" }, list: [1] });
  });

  it("sends null when a variable is null", () => {
    expect(fillJson({ parent: "{parent}" }, { parent: null })).toEqual({ parent: null });
  });

  it("encodes path variables and refuses a missing one", () => {
    expect(fillPath("/issues/{key}/x", { key: "A/../B" })).toBe("/issues/A%2F..%2FB/x");
    expect(() => fillPath("/issues/{key}", {})).toThrow(/needs \{key\}/);
  });

  it("leaves out a query parameter without its variable", () => {
    expect(fillQuery({ search: "{text}", limit: "1000" }, {})).toEqual({ limit: "1000" });
  });
});

describe("API profile", () => {
  it("accepts the README example", () => {
    expect(profile.requests.search.method).toBe("POST");
    expect(profile.auth).toEqual({ header: "X-API-Key", format: "{key}" });
  });

  it("names the place of a mistake", () => {
    expect(() => parseProfile("{")).toThrow(/not valid JSON/);
    expect(() => parseProfile(JSON.stringify({ ...MOCK_PROFILE, requests: { issue: MOCK_PROFILE.requests.issue } }))).toThrow(/requests\.myself/);
    expect(() => parseProfile(JSON.stringify({ ...MOCK_PROFILE, auth: { header: "X-API-Key", format: "no key" } }))).toThrow(/\{key\}/);
    expect(() => parseProfile(JSON.stringify({ ...MOCK_PROFILE, extra: 1 }))).toThrow();
  });

  it("keeps the address on https, except for this machine", () => {
    expect(normalizeBaseUrl("https://t.example.com/api/v1/")).toBe("https://t.example.com/api/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:8787/api")).toBe("http://127.0.0.1:8787/api");
    expect(() => normalizeBaseUrl("http://t.example.com")).toThrow(/https/);
    expect(() => normalizeBaseUrl("https://user:pw@t.example.com")).toThrow(/login/);
  });

  it("sorts statuses into three categories", () => {
    expect(categoryOf("in_progress")).toBe("progress");
    expect(categoryOf("Done")).toBe("done");
    expect(categoryOf("open")).toBe("todo");
    expect(categoryOf(null)).toBe("progress");
  });
});

describe("issues", () => {
  it("reads a flat search entry and an object-valued single issue", () => {
    const flat = issueFrom({ key: "PAY-112", id: "u-1", queue_key: "PAY", summary: "[BE] Saved cards", type: "task", status: "review", status_category: "in_progress", priority: "high", assignee_id: "u2", parent_key: "PAY-120", labels: ["a"] }, profile);
    expect(flat).toMatchObject({ key: "PAY-112", kind: "task", status: "review", category: "progress", assignee: "u2", parent: "PAY-120", labels: ["a"], queue: "PAY" });
    const full = issueFrom({ key: { value: "PAY-101" }, summary: "Epic", type: { code: "epic", name: "Epic" }, status: { code: "done", name: "Done" } }, profile);
    expect(full).toMatchObject({ key: "PAY-101", kind: "epic", status: "done", statusName: "Done", category: "done" });
    expect(issueFrom({ summary: "no key" }, profile)).toBeNull();
  });

  it("takes a status category the build configured over the tracker's", () => {
    const configured = { ...profile, statuses: [...profile.statuses, { key: "cancelled", category: "done", show: "used" as const }] };
    const raw = { key: "PAY-9", summary: "x", type: "task", status: "cancelled", status_category: "in_progress" };
    expect(issueFrom(raw, profile)?.category).toBe("progress");
    expect(issueFrom(raw, configured)?.category).toBe("done");
  });

  it("keeps epics on a board and leaves out only the board's own root", () => {
    const issues = [
      issueFrom({ key: "PAY-101", summary: "Card payment", type: "epic", status: "open" }, profile)!,
      issueFrom({ key: "PAY-130", summary: "Refunds", type: "epic", status: "open" }, profile)!,
      issueFrom({ key: "PAY-120", summary: "[S] Saved cards", type: "story", status: "ready", parent_key: "PAY-101" }, profile)!,
    ];
    expect(boardCards(issues, null).map((issue) => issue.key)).toEqual(["PAY-101", "PAY-130", "PAY-120"]);
    expect(boardCards(issues, "PAY-101").map((issue) => issue.key)).toEqual(["PAY-130", "PAY-120"]);
  });

  it("finds keys and prefixes", () => {
    expect(findKey("https://tracker.example.com/PAY-110?x=1")).toBe("PAY-110");
    expect(findKey("nothing here")).toBeNull();
    expect(splitPrefix("[BE] Saved cards")).toEqual({ prefix: "BE", rest: "Saved cards" });
    expect(splitPrefix("[not a prefix at all] x")).toEqual({ prefix: "", rest: "[not a prefix at all] x" });
    expect(splitPrefix("Plain")).toEqual({ prefix: "", rest: "Plain" });
  });

  it("reads a board source from what a person types", () => {
    expect(parseSource("pay-110", true)).toEqual({ kind: "issue", key: "PAY-110" });
    expect(parseSource("PAY", true)).toEqual({ kind: "queue", queue: "PAY" });
    expect(parseSource("https://tracker.example.com/PAY-7", true)).toEqual({ kind: "issue", key: "PAY-7" });
    expect(parseSource("status = open", true)).toEqual({ kind: "query", query: "status = open" });
    expect(parseSource("status = open", false)).toBeNull();
    // A pasted link without its scheme opens the issue, and a link without a key is never a query.
    expect(parseSource("tracker.example.com/PAY-7", true)).toEqual({ kind: "issue", key: "PAY-7" });
    expect(parseSource("https://tracker.example.com/agile/board/12", true)).toBeNull();
    expect(parseSource("tracker.example.com/agile/board/12", true)).toBeNull();
  });
});

describe("templates", () => {
  const config = parseTemplates(JSON.stringify(MOCK_TEMPLATES));
  const parent = issueFrom({ key: "PAY-120", summary: "[S] Saved cards", type: "story", status: "ready", priority: "high", queue_key: "PAY" }, profile)!;
  const epic = issueFrom({ key: "PAY-101", summary: "Card payment", type: "epic", status: "open", priority: "low" }, profile)!;
  const child = (key: string, summary: string) => issueFrom({ key, summary, type: "task", status: "open", parent_key: parent.key }, profile)!;

  it("puts the quarter and the year into labels", () => {
    expect(expandLabel("TEAM-QA-Q{Q}{YY}", new Date(2026, 10, 7))).toBe("TEAM-QA-Q426");
    expect(expandLabel("R-{YYYY}-Q{Q}", new Date(2027, 0, 1))).toBe("R-2027-Q1");
  });

  it("titles a child after its parent without the parent's prefix", () => {
    expect(childTitle(config.templates[2]!, "[S] Saved cards")).toBe("[BE] Saved cards");
  });

  it("marks parts that exist and plans the rest", () => {
    const rows = planRows({ parent, children: [child("PAY-121", "[D] Saved cards")], templates: config.templates, now: new Date(2026, 10, 7), defaultType: "task" }, ["D", "BE"].map((template) => ({ template })));
    expect(rows.map((row) => [row.template, row.exists, row.title, row.labels[0]])).toEqual([
      ["D", "PAY-121", "[D] Saved cards", "TEAM-DESIGN-Q426"],
      ["BE", null, "[BE] Saved cards", "TEAM-BACKEND-Q426"],
    ]);
    expect(rows[1]!.parentKey).toBe("PAY-120");
  });

  it("puts a bundle's tasks under the story it creates", () => {
    const rows = planRows({ parent: epic, children: [], templates: config.templates, now: new Date(2026, 10, 7), defaultType: "task" }, config.bundles[0]!.items);
    expect(rows[0]).toMatchObject({ template: "S", parentKey: "PAY-101", priority: "low", assignee: "@me" });
    expect(rows.slice(1).every((row) => row.parentRef === rows[0]!.ref && row.parentKey === null)).toBe(true);
    expect(rows.length).toBe(6);
  });

  it("refuses a bundle with an unknown template and a person's template with a build id", () => {
    expect(() => parseTemplates(JSON.stringify({ templates: [], bundles: [{ id: "X", title: "X", items: [{ template: "NOPE" }] }] }))).toThrow(/unknown template NOPE/);
    const merged = mergeTemplates(config.templates, [{ ...config.templates[1]!, title: "Mine" }, { ...config.templates[1]!, id: "MY1", title: "Docs" }]);
    expect(merged.filter((template) => template.id === "D").map((template) => template.title)).toEqual(["Design"]);
    expect(merged.find((template) => template.id === "MY1")?.own).toBe(true);
  });
});
