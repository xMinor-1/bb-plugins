// The board's filters: the type filter offers every type the build lists and any other
// type the board's tasks have, and filters by the tracker's own type.
import { describe, expect, it } from "vitest";
import { applyFilters, NO_FILTERS, typeOptions } from "../src/app/Toolbar";
import { issueFrom, type Issue } from "../src/shared/model";
import { parseProfile } from "../src/shared/profile";
import { MOCK_PROFILE } from "./fixtures/mock-tracker";

const profile = parseProfile(JSON.stringify({ ...MOCK_PROFILE, kinds: { ...MOCK_PROFILE.kinds, bug: ["bug", "incident"] } }));
const make = (key: string, type: string): Issue => issueFrom({ key, summary: key, type, status: "open" }, profile)!;
const types = [
  { key: "task", name: "Task", kind: "task" as const },
  { key: "bug", name: "Bug", kind: "bug" as const },
  { key: "release", name: "Release", kind: "task" as const },
];
const issues = [make("A-1", "task"), make("A-2", "Bug"), make("A-3", "incident"), make("A-4", "incident"), make("A-5", "improvement")];

describe("the type filter", () => {
  it("lists the build's types in order, with none on the board too, then the board's other types", () => {
    expect(typeOptions(types, issues)).toEqual([
      { key: "task", name: "Task", kind: "task", count: 1 },
      { key: "bug", name: "Bug", kind: "bug", count: 1 },
      { key: "release", name: "Release", kind: "task", count: 0 },
      { key: "incident", name: "incident", kind: "bug", count: 2 },
      { key: "improvement", name: "improvement", kind: "task", count: 1 },
    ]);
  });

  it("works without a list in the build", () => {
    expect(typeOptions([], issues).map((type) => type.key)).toEqual(["incident", "Bug", "improvement", "task"]);
  });

  it("keeps the tasks of the picked type, not of its kind", () => {
    const keys = (type: string | null) => applyFilters(issues, { ...NO_FILTERS, type }, null, () => "").map((issue) => issue.key);
    expect(keys("incident")).toEqual(["A-3", "A-4"]);
    expect(keys("bug")).toEqual(["A-2"]);
    expect(keys(null)).toHaveLength(5);
  });
});
