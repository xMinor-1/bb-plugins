import { describe, expect, it } from "vitest";
import {
  groupedScenarios,
  initialAnswers,
  missingFields,
  parseCatalog,
  pinnedScenarios,
  renderPrompt,
  togglePin,
  MAX_CATALOG_CHARS,
} from "../src/catalog";
import { CATALOG, CATALOG_JSON } from "./fixtures";

const catalog = parseCatalog(CATALOG_JSON);
const byId = (id: string) => catalog.scenarios.find((scenario) => scenario.id === id)!;

describe("parseCatalog", () => {
  it("reads a full catalog without problems", () => {
    expect(catalog.problems).toEqual([]);
    expect(catalog.scenarios.map((s) => s.id)).toEqual(["report-guide", "contract-check", "plain"]);
    expect(byId("plain").fields).toEqual([]);
  });

  it("treats empty input as an empty catalog", () => {
    expect(parseCatalog("")).toEqual({ groups: [], scenarios: [], problems: [] });
    expect(parseCatalog(undefined).scenarios).toEqual([]);
  });

  it("reports broken JSON and oversize input instead of throwing", () => {
    expect(parseCatalog("{").problems[0]).toMatch(/not JSON/);
    expect(parseCatalog("x".repeat(MAX_CATALOG_CHARS + 1)).problems[0]).toMatch(/longer/);
    expect(parseCatalog("42").problems[0]).toMatch(/object/);
  });

  it("accepts a bare array of scenarios", () => {
    const parsed = parseCatalog(JSON.stringify([{ id: "a", label: "A" }]));
    expect(parsed.scenarios.map((s) => s.id)).toEqual(["a"]);
    expect(parsed.problems).toEqual([]);
  });

  it("skips a broken scenario and keeps the rest", () => {
    const parsed = parseCatalog(
      JSON.stringify({
        scenarios: [
          { id: "ok", label: "OK" },
          { id: "bad", label: "" },
          { id: "ok", label: "Again" },
          { id: "typo", label: "Typo", fields: [{ id: "a", label: "A", type: "text" }], prompt: "{{b}}" },
          { id: "twice", label: "Twice", fields: [{ id: "a", label: "A", type: "text" }, { id: "a", label: "B", type: "text" }] },
          { id: "reserved", label: "R", fields: [{ id: "answers", label: "A", type: "text" }] },
          { id: "kind", label: "K", fields: [{ id: "a", label: "A", type: "date" }] },
        ],
      }),
    );
    expect(parsed.scenarios.map((s) => s.id)).toEqual(["ok"]);
    expect(parsed.problems).toHaveLength(6);
    expect(parsed.problems.join("\n")).toMatch(/\(bad\)/);
    expect(parsed.problems.join("\n")).toMatch(/\{\{b\}\}/);
  });

  it("names an undeclared group after its id", () => {
    const parsed = parseCatalog(JSON.stringify({ scenarios: [{ id: "a", label: "A", group: "misc" }] }));
    expect(parsed.groups).toEqual([{ id: "misc", label: "misc" }]);
  });
});

describe("grouping and pins", () => {
  it("groups in catalog order with ungrouped scenarios last", () => {
    expect(groupedScenarios(catalog).map(({ group, scenarios }) => [group?.id ?? null, scenarios.map((s) => s.id)])).toEqual([
      ["contracts", ["contract-check"]],
      ["reports", ["report-guide"]],
      [null, ["plain"]],
    ]);
  });

  it("shows the catalog's pins until the person picks their own", () => {
    expect(pinnedScenarios(catalog, null).map((s) => s.id)).toEqual(["report-guide"]);
    const own = togglePin(catalog, null, "plain");
    expect(own).toEqual({ pins: ["report-guide", "plain"], known: ["report-guide"] });
    const fewer = togglePin(catalog, own, "report-guide");
    expect(pinnedScenarios(catalog, fewer).map((s) => s.id)).toEqual(["plain"]);
  });

  it("adds a default pin that is new in the catalog to an own pick", () => {
    const own = { pins: ["plain"], known: ["report-guide"] };
    const next = parseCatalog(JSON.stringify({ ...CATALOG, scenarios: CATALOG.scenarios.map((s) => (s.id === "contract-check" ? { ...s, pinned: true } : s)) }));
    expect(pinnedScenarios(next, own).map((s) => s.id)).toEqual(["plain", "contract-check"]);
    // Unpinning it once keeps it out from then on.
    const after = togglePin(next, own, "contract-check");
    expect(pinnedScenarios(next, after).map((s) => s.id)).toEqual(["plain"]);
  });

  it("drops pins of scenarios that left the catalog", () => {
    expect(pinnedScenarios(catalog, { pins: ["gone", "plain"], known: [] }).map((s) => s.id)).toEqual(["plain", "report-guide"]);
  });
});

describe("answers and the prompt", () => {
  it("blocks on required answers, including an attached file", () => {
    const scenario = byId("contract-check");
    const answers = initialAnswers(scenario);
    expect(missingFields(scenario, answers, 0).map((f) => f.id)).toEqual(["party", "file"]);
    expect(missingFields(scenario, { ...answers, party: "  " }, 1).map((f) => f.id)).toEqual(["party"]);
    expect(missingFields(scenario, { ...answers, party: "Acme" }, 1)).toEqual([]);
  });

  it("drops a template line whose answers are empty", () => {
    const scenario = byId("report-guide");
    expect(renderPrompt(scenario, { question: " Which sheet? ", period: "" }, 0)).toBe("Read the reports guide first.\nQuestion: Which sheet?");
    expect(renderPrompt(scenario, { question: "Q", period: "May" }, 0)).toBe("Read the reports guide first.\nQuestion: Q\nPeriod: May");
  });

  it("fills an attachment with its answer text and lists the rest under {{answers}}", () => {
    const scenario = byId("contract-check");
    expect(renderPrompt(scenario, { party: "Acme", side: "Buyer" }, 1)).toBe(
      "Use the contract-check skill.\nCounterparty: Acme\nContract: see the attached file\nOur side: Buyer",
    );
    expect(renderPrompt(scenario, { party: "Acme", side: "" }, 1)).toBe("Use the contract-check skill.\nCounterparty: Acme\nContract: see the attached file");
  });

  it("lists every answer when the scenario has no template", () => {
    const parsed = parseCatalog(
      JSON.stringify([{ id: "a", label: "A", fields: [{ id: "x", label: "X", type: "text" }, { id: "y", label: "Y", type: "textarea" }] }]),
    );
    expect(renderPrompt(parsed.scenarios[0]!, { x: "1", y: "two\nlines" }, 0)).toBe("X: 1\nY:\ntwo\nlines");
  });

  it("keeps an answer that looks like a placeholder as text", () => {
    const scenario = byId("report-guide");
    expect(renderPrompt(scenario, { question: "{{period}}", period: "" }, 0)).toBe("Read the reports guide first.\nQuestion: {{period}}");
  });
});

import { catalogEntry, checkScenario, editPrompt, MINE_GROUP, withOwn } from "../src/catalog";

describe("own scenarios", () => {
  const mine = { id: "my-abc12345", label: "Invoice", group: MINE_GROUP, pinned: false, fields: [], prompt: "Check it" };

  it("puts own scenarios first under Mine and lets them win an id clash", () => {
    const clash = { ...mine, id: "plain", label: "My plain" };
    const merged = withOwn(catalog, [mine, clash], "Mine");
    expect(merged.groups[0]).toEqual({ id: MINE_GROUP, label: "Mine" });
    expect(merged.scenarios.map((s) => s.id)).toEqual(["my-abc12345", "plain", "report-guide", "contract-check"]);
    expect(groupedScenarios(merged)[0]!.scenarios.map((s) => s.label)).toEqual(["Invoice", "My plain"]);
    expect(withOwn(catalog, [], "Mine")).toBe(catalog);
  });

  it("an own scenario never comes pinned by default", () => {
    const merged = withOwn(catalog, [{ ...mine, pinned: true }], "Mine");
    expect(pinnedScenarios(merged, null).map((s) => s.id)).toEqual(["report-guide"]);
  });

  it("the suggested file is a plain catalog entry that passes the checks", () => {
    const entry = catalogEntry({ ...mine, fields: [{ id: "x", label: "X", type: "text" }] });
    expect(entry).toEqual({ id: "abc12345", label: "Invoice", fields: [{ id: "x", label: "X", type: "text" }], prompt: "Check it" });
    expect("scenario" in checkScenario(entry)).toBe(true);
    expect(catalogEntry(mine)).not.toHaveProperty("fields");
  });

  it("fills the edit prompt and leaves unknown placeholders alone", () => {
    const out = editPrompt("Change {{label}} ({{id}}) {{other}}\n{{scenario}}", mine);
    expect(out.startsWith("Change Invoice (my-abc12345) {{other}}\n{")).toBe(true);
    expect(JSON.parse(out.slice(out.indexOf("\n{") + 1))).toMatchObject({ id: "my-abc12345" });
  });
});
