// A story card's composition row: one cell per template part and one for everything else,
// however many tasks the story has.
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
    expect(html).toContain(">+34<");
    expect(html).toContain("Done 28 of 35");
  });

  it("shows no extra cell when every task is a part", () => {
    const html = render(story, [kid(1, "[D] Saved cards"), kid(2, "[BE] Saved cards")]);
    expect(html).not.toContain("tb-tile-extra");
  });
});
