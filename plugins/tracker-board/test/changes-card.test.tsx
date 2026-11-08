// The card an agent's reply carries when it changed tasks without a form.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangesCardView } from "../src/app/ChangesCard";
import { messages } from "../src/app/messages";
import type { AppliedItemView, AppliedView } from "../src/server/rpc-contract";

const item = (id: string, change: AppliedItemView["planned"]["change"], extra: Partial<AppliedItemView> = {}): AppliedItemView => ({
  planned: { id, change, key: "key" in change ? change.key : null, title: "Saved cards", ok: true, skip: null, from: "Open", to: "Done" },
  ok: true,
  key: null,
  code: null,
  canUndo: change.kind !== "comment",
  undo: null,
  undoCode: null,
  ...extra,
});

const view: AppliedView = {
  tracker: "Tracker",
  at: 1,
  undoneAt: null,
  items: [
    item("c1", { kind: "status", key: "PAY-140", to: "done" }),
    item("c2", { kind: "comment", key: "PAY-140", text: "Closed" }),
    item("c3", { kind: "assignee", key: "PAY-150", to: "u4" }, { ok: false, canUndo: false, code: "forbidden" }),
  ],
};

const render = (next: AppliedView, lang: "en" | "ru" = "en") => renderToStaticMarkup(createElement(ChangesCardView, { t: messages[lang], view: next, busy: false, error: null, onUndo: () => undefined }));

describe("the changes card", () => {
  it("says what changed, what failed and what cannot go back, with Undo", () => {
    const html = render(view);
    expect(html).toContain("Changed in Tracker: 2 changes");
    expect(html).toContain("1 not applied");
    expect(html).toContain("can&#x27;t be undone");
    expect(html).toContain(">Undo</button>");
  });

  it("after Undo: what went back, what someone changed since, no button", () => {
    const after: AppliedView = {
      ...view,
      undoneAt: 2,
      items: [{ ...view.items[0]!, canUndo: false, undo: "undone" }, { ...view.items[1]!, canUndo: false }, { ...view.items[2]! }],
    };
    const html = render(after, "ru");
    expect(html).toContain("Отменено 1 из 2");
    expect(html).toContain("отменено");
    expect(html).toContain("не отменяется");
    expect(html).not.toContain("<button");
    const changed = render({ ...after, items: [{ ...after.items[0]!, undo: "changedSince" }] }, "ru");
    expect(changed).toContain("с тех пор изменили, оставлено");
  });
});
