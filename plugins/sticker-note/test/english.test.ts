import { describe, expect, it } from "vitest";

import { parsePhrase } from "../src/parse";

// Saturday, 31 October 2026, 13:40.
const now = { date: "2026-10-31", time: "13:40" };
const cards = [
  { id: "parcel", title: "Pick up the parcel", done: false },
  { id: "service", title: "Call the service about the MOT", done: false },
  { id: "prd", title: "Read the PRD", done: false },
  { id: "passport", title: "Apply for a passport", done: false },
  { id: "filters", title: "Buy vacuum filters", done: false },
  { id: "leads", title: "Send the leads report", done: true },
];
const parse = (text: string) => parsePhrase({ text, now, cards });

describe("English phrases from the README", () => {
  it("new tasks", () => {
    const a = parse("Tomorrow at 10 call the dentist");
    expect(a.type === "create" && a.draft).toMatchObject({ title: "Call the dentist", due: { date: "2026-11-01", time: "10:00" } });
    const b = parse("On Thursday renew the car insurance sravni.ru");
    expect(b.type === "create" && b.draft).toMatchObject({ due: { date: "2026-11-05", time: null }, links: ["sravni.ru"] });
    const c = parse("Someday buy a new kettle");
    expect(c.type === "create" && c.draft).toMatchObject({ due: null, importance: "low" });
  });

  it.each([
    ["mark the parcel done", "done", "parcel"],
    ["move the service call to Wednesday at 12", "move", "service"],
    ["postpone the PRD", "move", "prd"],
    ["make the passport urgent", "importance", "passport"],
    ["delete the filters", "delete", "filters"],
    ["reopen the leads report", "undone", "leads"],
  ])("%s", (text, action, target) => {
    expect(parse(text)).toMatchObject({ type: "command", action, targetId: target });
  });

  it("move keeps the new time", () => {
    const r = parse("move the service call to Wednesday at 12");
    expect(r.type === "command" && r.due).toEqual({ date: "2026-11-04", time: "12:00" });
  });
});
