import { describe, expect, it } from "vitest";
import {
  applyCuration,
  baselineCuration,
  EMPTY_CURATION,
  hiddenScenarios,
  MAX_SEEN,
  MINE_GROUP,
  newScenarioIds,
  parseCatalog,
  pinsAfterHide,
  pinsAfterToggle,
  rowScenarios,
  searchScenarios,
  visibleCatalog,
  withOwn,
  type Scenario,
} from "../src/catalog";
import { CATALOG_JSON } from "./fixtures";

const catalog = parseCatalog(CATALOG_JSON);
const ids = (scenarios: readonly Scenario[]) => scenarios.map((scenario) => scenario.id);
const mine: Scenario = { id: "my-12345678", label: "Mine one", group: MINE_GROUP, fields: [], prompt: "x" };

/** A catalog of twelve, three of them pinned. */
function bigCatalog(extra: unknown[] = []) {
  const scenarios = Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`,
    label: `Scenario ${i}`,
    group: i < 6 ? "a" : "b",
    ...(i < 3 ? { pinned: true } : {}),
  }));
  return parseCatalog(JSON.stringify({ groups: [{ id: "a", label: "A" }, { id: "b", label: "B" }], scenarios: [...scenarios, ...extra] }));
}

describe("hidden scenarios", () => {
  it("leave the expanded view and the row; own scenarios never hide", () => {
    const all = withOwn(catalog, [mine], "Mine");
    const visible = visibleCatalog(all, ["report-guide", "plain", mine.id]);
    expect(ids(visible.scenarios)).toEqual([mine.id, "contract-check"]);
    expect(ids(hiddenScenarios(all, ["report-guide", "plain", mine.id, "gone"]))).toEqual(["report-guide", "plain"]);
    expect(ids(rowScenarios(catalog, null, ["report-guide"]))).toEqual([]);
  });

  it("hiding a tag in the row takes it out of the pick, so showing it again leaves the row alone", () => {
    const pins = pinsAfterHide(catalog, null, [], "report-guide")!;
    expect(pins.pins).toEqual([]);
    expect(pins.known).toContain("report-guide");
    const { next } = applyCuration(EMPTY_CURATION, { hide: ["report-guide"] });
    const shown = applyCuration(next, { unhide: ["report-guide"] }).next;
    expect(ids(rowScenarios(catalog, pins, shown.hidden))).toEqual([]);
    // A tag outside the row does not touch the pins.
    expect(pinsAfterHide(catalog, null, [], "plain")).toBeUndefined();
  });

  it("adding a hidden tag to the row pins it as visible", () => {
    const pins = pinsAfterToggle(catalog, null, ["plain"], "plain");
    expect(pins.pins).toEqual(["report-guide", "plain"]);
    expect(ids(rowScenarios(catalog, pins, []))).toEqual(["report-guide", "plain"]);
    // Toggling again removes it.
    expect(pinsAfterToggle(catalog, pins, [], "plain").pins).toEqual(["report-guide"]);
  });

  it("does not let a hidden default jump back into the row when it is shown again", () => {
    const pins = pinsAfterToggle(catalog, null, ["report-guide"], "plain");
    expect(pins.known).toContain("report-guide");
    expect(ids(rowScenarios(catalog, pins, []))).toEqual(["plain"]);
  });
});

describe("applyCuration", () => {
  it("reports no change when nothing moves, so no signal goes out", () => {
    const start = { hidden: ["a"], seen: ["a", "b"] };
    expect(applyCuration(start, {}).changed).toBe(false);
    expect(applyCuration(start, { hide: ["a"], seen: ["b"] }).changed).toBe(false);
    expect(applyCuration(start, { unhide: ["zzz"] }).changed).toBe(false);
    expect(applyCuration(start, { hide: ["c"] })).toEqual({ next: { hidden: ["a", "c"], seen: ["a", "b", "c"] }, changed: true });
    // Hiding before any baseline leaves the baseline to the first catalog read.
    expect(applyCuration(EMPTY_CURATION, { hide: ["c"] }).next).toEqual({ hidden: ["c"], seen: null });
    expect(applyCuration(start, { unhide: ["a"] }).next.hidden).toEqual([]);
  });

  it("never stores an own scenario as hidden and keeps the seen list bounded", () => {
    expect(applyCuration(EMPTY_CURATION, { hide: ["my-12345678"] }).next.hidden).toEqual([]);
    const many = Array.from({ length: MAX_SEEN + 5 }, (_, i) => `x${i}`);
    const { next } = applyCuration({ hidden: [], seen: [] }, { seen: many });
    expect(next.seen).toHaveLength(MAX_SEEN);
    expect(next.seen!.at(-1)).toBe(`x${MAX_SEEN + 4}`);
  });
});

describe("new scenarios", () => {
  it("the first catalog becomes the baseline, so nothing starts as new", () => {
    expect(newScenarioIds(catalog, null).size).toBe(0);
    expect(baselineCuration(EMPTY_CURATION, parseCatalog(""))).toBeUndefined();
    const baseline = baselineCuration(EMPTY_CURATION, catalog)!;
    expect(baseline.seen).toEqual(["report-guide", "contract-check", "plain"]);
    expect(baselineCuration(baseline, catalog)).toBeUndefined();
    expect(newScenarioIds(catalog, baseline.seen).size).toBe(0);
  });

  it("a scenario added in a later catalog is new until seen, and stays out of the row unless pinned", () => {
    const first = bigCatalog();
    let curation = baselineCuration(EMPTY_CURATION, first)!;
    // The person hides three and adds two to the row.
    let pins = null as ReturnType<typeof pinsAfterToggle> | null;
    for (const id of ["s0", "s4", "s7"]) {
      pins = pinsAfterHide(first, pins, curation.hidden, id) ?? pins;
      curation = applyCuration(curation, { hide: [id] }).next;
    }
    for (const id of ["s5", "s9"]) pins = pinsAfterToggle(first, pins, curation.hidden, id);
    expect(ids(rowScenarios(first, pins, curation.hidden))).toEqual(["s1", "s2", "s5", "s9"]);

    const updated = bigCatalog([
      { id: "s12", label: "Added later", group: "a" },
      { id: "s13", label: "Added and pinned", group: "b", pinned: true },
    ]);
    expect([...newScenarioIds(updated, curation.seen)]).toEqual(["s12", "s13"]);
    expect(ids(rowScenarios(updated, pins, curation.hidden))).toEqual(["s1", "s2", "s5", "s9", "s13"]);
    expect(ids(hiddenScenarios(updated, curation.hidden))).toEqual(["s0", "s4", "s7"]);

    curation = applyCuration(curation, { seen: ["s12", "s13"] }).next;
    expect(newScenarioIds(updated, curation.seen).size).toBe(0);
  });

  it("own scenarios are never new", () => {
    expect(newScenarioIds(withOwn(catalog, [mine], "Mine"), []).has(mine.id)).toBe(false);
  });
});

describe("searchScenarios", () => {
  const all = withOwn(catalog, [mine], "Mine");
  it("matches every word across label, description, group and questions, ignoring case", () => {
    expect(ids(searchScenarios(all, ""))).toEqual(ids(all.scenarios));
    expect(ids(searchScenarios(all, "REPORT"))).toEqual(["report-guide"]);
    expect(ids(searchScenarios(all, "counterparty"))).toEqual(["contract-check"]);
    expect(ids(searchScenarios(all, "contracts buyer"))).toEqual([]);
    expect(ids(searchScenarios(all, "contracts check"))).toEqual(["contract-check"]);
    expect(ids(searchScenarios(all, "  period   question "))).toEqual(["report-guide"]);
  });

  it("folds Russian case and ё", () => {
    const ru = parseCatalog(JSON.stringify({ scenarios: [{ id: "a", label: "Проверить счёт" }, { id: "b", label: "Отчёт" }] }));
    expect(ids(searchScenarios(ru, "СЧЕТ"))).toEqual(["a"]);
    expect(ids(searchScenarios(ru, "отче"))).toEqual(["b"]);
  });
});
