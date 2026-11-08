// A story card's composition row: one cell per template part and one for everything else,
// each with done of total, however many tasks the story has.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composition } from "../src/app/Card";
import { messages } from "../src/app/messages";
import { childrenOf, ViewContext, type ViewData } from "../src/app/view";
import { issueFrom, type Issue } from "../src/shared/model";
import { parseProfile } from "../src/shared/profile";
import { parseTemplates } from "../src/shared/templates";
import { MOCK_PROFILE, MOCK_TEMPLATES } from "./fixtures/mock-tracker";

const profile = parseProfile(JSON.stringify(MOCK_PROFILE));
const templates = parseTemplates(JSON.stringify(MOCK_TEMPLATES)).templates;
const parts = templates.filter((template) => template.under === "story");

function render(story: Issue, kids: Issue[]): string {
  const view = {
    t: messages.en,
    colors: new Map([["open", "#888"], ["done", "#3a3"]]),
    statusName: (key: string) => key,
    children: childrenOf([story, ...kids]),
    parts,
  } as unknown as ViewData;
  return renderToStaticMarkup(createElement(ViewContext.Provider, { value: view }, createElement(Composition, { story })));
}

describe("story composition on a card", () => {
  const story = issueFrom({ key: "PAY-120", summary: "[S] Saved cards", type: "story", status: "open" }, profile)!;
  const kid = (n: number, summary: string, status = "open") => issueFrom({ key: `PAY-${200 + n}`, summary, type: "task", status, parent_key: story.key }, profile)!;

  it("keeps one cell per part and one for all other tasks, with 35 tasks", () => {
    const kids = Array.from({ length: 35 }, (_, n) => kid(n, n % 3 === 0 ? `[BE] Part ${n}` : `Task ${n}`, n < 28 ? "done" : "open"));
    const html = render(story, kids);
    const tiles = html.match(/class="tb-tile[ "]/g) ?? [];
    expect(tiles.length).toBe(parts.length + 1);
    // Every [BE] task counts for BE (10 of 12 done), the rest for "other" (18 of 23).
    expect(html).toContain("<b>BE</b><i>10/12</i>");
    expect(html).toContain("<b>other</b><i>18/23</i>");
    expect(html).toContain("Done 28 of 35");
  });

  it("marks each cell by state: all done, in work, no tasks", () => {
    const html = render(story, [kid(1, "[D] Saved cards", "done"), kid(2, "[BE] Saved cards"), kid(3, "[BE] Saved cards API", "done")]);
    expect(html).toMatch(/tb-tile-done"[^>]*><b>D<\/b><i>1\/1/);
    expect(html).toMatch(/tb-tile-work"[^>]*><b>BE<\/b><i>1\/2/);
    expect(html).toMatch(/tb-tile-none"[^>]*><b>QA<\/b><i>–/);
    expect(html).toMatch(/tb-tile-none tb-tile-other"[^>]*><b>other<\/b>/);
  });
});
