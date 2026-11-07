// A task's parents in the side panel: one row each, the epic with its progress, the story
// with its composition row, this task last.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { messages } from "../src/app/messages";
import { EpicProgress, ParentExtra, ParentPath, descendants, type PathData } from "../src/app/ParentPath";
import { childrenOf } from "../src/app/view";
import { issueFrom, type Issue } from "../src/shared/model";
import { parseProfile } from "../src/shared/profile";
import { parseTemplates } from "../src/shared/templates";
import type { StatusView } from "../src/server/rpc-contract";
import { MOCK_PROFILE, MOCK_TEMPLATES } from "./fixtures/mock-tracker";

const profile = parseProfile(JSON.stringify(MOCK_PROFILE));
const parts = parseTemplates(JSON.stringify(MOCK_TEMPLATES)).templates.filter((template) => template.under === "story");
const statuses: StatusView[] = [
  { key: "open", name: "Open", category: "todo" },
  { key: "in_progress", name: "In progress", category: "progress" },
  { key: "done", name: "Done", category: "done" },
];
const make = (key: string, type: string, summary: string, status: string, parent: string | null): Issue =>
  issueFrom({ key, summary, type, status, parent_key: parent }, profile)!;

const epic = make("PAY-101", "epic", "Card payment in the mobile app", "in_progress", null);
const story = make("PAY-110", "story", "[S] Card payment at checkout", "in_progress", "PAY-101");
const bug = make("PAY-140", "bug", "Double charge on a repeated Pay tap", "open", "PAY-110");
const tree = [
  epic,
  story,
  bug,
  make("PAY-111", "task", "[D] Card payment at checkout", "done", "PAY-110"),
  make("PAY-112", "task", "[BE] Card payment at checkout", "in_progress", "PAY-110"),
  make("PAY-150", "task", "Acquirer contract", "done", "PAY-101"),
];

const data = (lang: "en" | "ru", children: PathData["children"], loading = false): PathData => ({
  t: messages[lang],
  children,
  loading,
  parts,
  statuses,
  colors: new Map([["done", "#3a3"]]),
  statusName: (key) => statuses.find((status) => status.key === key)?.name ?? key,
});
const path = (next: PathData) => renderToStaticMarkup(createElement(ParentPath, { issue: bug, chain: [epic, story], data: next, onOpen: () => undefined }));

describe("the parents in the side panel", () => {
  it("lists the epic, the story and this task, each parent with its type, key, status and title", () => {
    const html = path(data("en", childrenOf(tree)));
    expect(html.match(/class="tb-pp-row/g)?.length).toBe(3);
    expect(html.match(/role="button"/g)?.length).toBe(2);
    expect(html).toContain('aria-label="Parents"');
    expect(html).toContain('title="Open PAY-101"');
    // The titles go without the role prefix; the story's title is plain text.
    expect(html).toContain('<div class="tb-pp-t">Card payment at checkout</div>');
    expect(html.indexOf("PAY-101")).toBeLessThan(html.indexOf("PAY-110"));
    expect(html.indexOf("PAY-110")).toBeLessThan(html.indexOf("This task"));
    // This task: no status and no title, the heading below has them.
    const me = html.slice(html.indexOf("tb-pp-me"));
    expect(me).not.toContain("tb-pill");
    expect(me).not.toContain("tb-pp-t");
  });

  it("shows the epic's progress over all its tasks and the story's composition", () => {
    const html = path(data("ru", childrenOf(tree)));
    // Everything under the epic, at any depth: 5 tasks, 2 done.
    expect(html).toContain("Готово 2 из 5");
    expect(html).toContain("Эта задача");
    expect(html).toContain("<b>BE</b><i>0/1</i>");
    expect(html).toContain("<b>D</b><i>1/1</i>");
  });

  it("holds a quiet bar while a parent's tree loads and nothing when it failed", () => {
    expect(path(data("en", null, true)).match(/tb-pp-wait/g)?.length).toBe(2);
    expect(path(data("en", null, false))).not.toContain("tb-pp-wait");
  });

  it("shows nothing for a task without parents, and says when an epic has no tasks yet", () => {
    expect(renderToStaticMarkup(createElement(ParentPath, { issue: epic, chain: [], data: data("en", childrenOf(tree)), onOpen: () => undefined }))).toBe("");
    const empty = renderToStaticMarkup(createElement(EpicProgress, { t: messages.en, issues: [], statuses, colors: new Map() }));
    expect(empty).toContain("No tasks yet");
    expect(renderToStaticMarkup(createElement(ParentExtra, { issue: bug, data: data("en", childrenOf(tree)) }))).toBe("");
  });

  it("walks a tree with a loop in it once", () => {
    const a = make("X-1", "epic", "A", "open", "X-2");
    const b = make("X-2", "story", "B", "open", "X-1");
    expect(descendants("X-1", childrenOf([a, b])).map((item) => item.key)).toEqual(["X-2"]);
  });
});
