// The board's filters: the type filter offers every type the build lists and any other
// type the board's tasks have, and filters by the tracker's own type.
import { describe, expect, it } from "vitest";
import { applyFilters, NO_FILTERS, statusOptions, typeOptions } from "../src/app/Toolbar";
import { issueFrom, type Issue } from "../src/shared/model";
import { parseProfile } from "../src/shared/profile";
import { MOCK_PROFILE } from "./fixtures/mock-tracker";

const profile = parseProfile(JSON.stringify({ ...MOCK_PROFILE, kinds: { ...MOCK_PROFILE.kinds, bug: ["bug", "incident"] } }));
const make = (key: string, type: string, status = "open"): Issue => issueFrom({ key, summary: key, type, status }, profile)!;
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

describe("the status filter", () => {
  const board = [make("B-1", "task", "open"), make("B-2", "task", "in_progress"), make("B-3", "task", "done"), make("B-4", "task", "done"), make("B-5", "task", "on_hold")];
  const keys = (filters: Partial<typeof NO_FILTERS>) => applyFilters(board, { ...NO_FILTERS, ...filters }, null, () => "").map((issue) => issue.key);

  it("hides closed tasks by default and shows them on request", () => {
    expect(keys({})).toEqual(["B-1", "B-2", "B-5"]);
    expect(keys({ hideClosed: false })).toHaveLength(5);
  });

  it("keeps only the picked statuses, a picked closed one too", () => {
    expect(keys({ statuses: ["in_progress", "done"] })).toEqual(["B-2", "B-3", "B-4"]);
    expect(keys({ statuses: ["open"], hideClosed: false })).toEqual(["B-1"]);
  });

  it("offers the statuses the board's tasks are in, in board order, others after by category", () => {
    const statuses = [
      { key: "open", name: "Open", category: "todo" as const },
      { key: "review", name: "Review", category: "progress" as const },
      { key: "in_progress", name: "In progress", category: "progress" as const },
      { key: "done", name: "Done", category: "done" as const },
    ];
    expect(statusOptions(statuses, board).map((option) => [option.key, option.count])).toEqual([
      ["open", 1],
      ["in_progress", 1],
      ["done", 2],
      ["on_hold", 1],
    ]);
  });
});
