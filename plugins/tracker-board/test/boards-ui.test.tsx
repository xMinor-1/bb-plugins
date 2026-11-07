// "My boards" in the panel: row labels, the settings section and the first-run step.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { boardLabel, BoardsSection, InterestStep, SourcePicker } from "../src/app/Boards";
import { messages } from "../src/app/messages";
import type { Rpc } from "../src/app/store";
import { prefsSchema, type Source } from "../src/shared/prefs";
import type { ConfigView } from "../src/server/rpc-contract";

const t = messages.en;
const rpc = { call: () => new Promise(() => undefined) } as unknown as Rpc;
const queue = (key: string): Source => ({ kind: "queue", queue: key });
const config = { defaultBoards: [queue("PAY")], allowQuery: false, problem: null, can: { queues: true, mine: true } } as unknown as ConfigView;
const prefs = prefsSchema.parse({
  boards: [{ source: { kind: "issue", key: "PAY-120" }, title: "PAY-120 Saved cards", kind: "story" }],
});

describe("board labels", () => {
  it("shows a key beside a name, or the key alone", () => {
    expect(boardLabel(t, { source: queue("PAY"), title: "Payments" })).toEqual({ key: "PAY", name: "Payments" });
    expect(boardLabel(t, { source: queue("PAY"), title: "PAY" })).toEqual({ key: null, name: "PAY" });
    expect(boardLabel(t, { source: { kind: "issue", key: "PAY-120" }, title: "PAY-120 Saved cards" })).toEqual({ key: "PAY-120", name: "Saved cards" });
    expect(boardLabel(t, { source: { kind: "issue", key: "PAY-120" }, title: "PAY-120" })).toEqual({ key: null, name: "PAY-120" });
    expect(boardLabel(t, { source: { kind: "mine" }, title: "" }).name).toBe(t.mine);
  });
});

describe("my boards in settings", () => {
  const html = renderToStaticMarkup(createElement(BoardsSection, { t, rpc, config, prefs }));

  it("lists the build's board with a lock and an eye, one's own with a star", () => {
    const rows = html.split(/class="tb-br[" ]/).slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(t.buildTag);
    expect(rows[0]).toContain(`aria-label="${t.hideBoard}"`);
    expect(rows[1]).toContain("PAY-120");
    expect(rows[1]).toMatch(/tb-star-on[^>]*aria-pressed="true"/);
    // Every row can be moved by its handle.
    expect(html.match(/data-handle=/g)).toHaveLength(2);
  });

  it("says where the shared boards come from", () => {
    expect(html).toContain("“Shared boards” setting");
  });
});

describe("the board list in the title bar", () => {
  it("names a queue board by its key and name", () => {
    const html = renderToStaticMarkup(createElement(SourcePicker, { t, rpc, config, prefs, current: { source: queue("PAY"), title: "Payments" }, onPick: () => undefined }));
    expect(html).toContain('<span class="tb-k">PAY</span><span class="tb-t">Payments</span>');
  });
});

describe("what are you interested in", () => {
  it("has the build's boards already in My boards, locked", () => {
    const html = renderToStaticMarkup(createElement(InterestStep, { t, rpc, config, prefs: prefsSchema.parse({}) }));
    expect(html).toContain(t.interestTitle);
    expect(html).toContain(t.lookingThrough);
    const aside = html.slice(html.indexOf("tb-mine-box"));
    expect(aside).toContain(t.buildTag);
    expect(aside).toContain(t.boardsCount(1));
    expect(aside).toContain(t.willOpen("PAY"));
  });
});
