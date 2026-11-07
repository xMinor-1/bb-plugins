// "My boards": the build's shared boards and the person's own, in the person's order.
import { describe, expect, it } from "vitest";
import { isPinned, moveBoard, myBoards, parseDefaultBoards, restoreBoard, setHidden, togglePinned, withTitle } from "../src/shared/boards";
import { prefsPatchSchema, prefsSchema, type Source } from "../src/shared/prefs";

const queue = (key: string): Source => ({ kind: "queue", queue: key });
const issue = (key: string): Source => ({ kind: "issue", key });
const ids = (saved: { source: Source }[]) => saved.map((board) => JSON.stringify(board.source));

describe("my boards", () => {
  it("reads the build's boards from keys, queues, links and 'mine'", () => {
    expect(parseDefaultBoards("PAY\nhttps://tracker.example.com/PAY-101, mine, PAY, not a board")).toEqual([queue("PAY"), issue("PAY-101"), { kind: "mine" }]);
  });

  it("puts the build's untouched boards on top and marks them", () => {
    const entries = myBoards([queue("PAY")], [{ source: issue("PAY-101"), title: "Card payment", hidden: false }]);
    expect(entries.map((entry) => [entry.id, entry.build])).toEqual([["queue:PAY", true], ["issue:PAY-101", false]]);
  });

  it("adds and removes the person's own board, but never removes the build's", () => {
    let entries = myBoards([queue("PAY")], []);
    let saved = togglePinned(entries, issue("PAY-120"), "Saved cards");
    expect(ids(saved)).toEqual([JSON.stringify(queue("PAY")), JSON.stringify(issue("PAY-120"))]);
    entries = myBoards([queue("PAY")], saved);
    saved = togglePinned(entries, issue("PAY-120"), "Saved cards");
    expect(ids(saved)).toEqual([JSON.stringify(queue("PAY"))]);
    entries = myBoards([queue("PAY")], saved);
    expect(ids(togglePinned(entries, queue("PAY"), "PAY"))).toEqual([JSON.stringify(queue("PAY"))]);
  });

  it("hides a build's board, and only a build's", () => {
    const entries = myBoards([queue("PAY")], [{ source: issue("PAY-101"), title: "", hidden: false }]);
    const saved = setHidden(myBoards([queue("PAY")], setHidden(entries, "queue:PAY", true)), "issue:PAY-101", true);
    expect(saved.map((board) => board.hidden)).toEqual([true, false]);
    expect(myBoards([queue("PAY")], saved)[0]!.hidden).toBe(true);
    // A board the build no longer shares becomes the person's own and shows again.
    expect(myBoards([], saved)[0]!.hidden).toBe(false);
  });

  it("orders boards, the build's among them", () => {
    const entries = myBoards([queue("PAY")], [{ source: issue("PAY-101"), title: "", hidden: false }, { source: { kind: "mine" }, title: "", hidden: false }]);
    expect(moveBoard(entries, "mine", "queue:PAY").map((board) => board.source.kind)).toEqual(["mine", "queue", "issue"]);
    expect(moveBoard(entries, "queue:PAY", null).map((board) => board.source.kind)).toEqual(["issue", "mine", "queue"]);
  });

  it("keeps the title of a board once it loads", () => {
    const saved = withTitle([{ source: issue("PAY-101"), title: "", hidden: false }], issue("PAY-101"), "Card payment");
    expect(saved[0]!.title).toBe("Card payment");
    expect(isPinned(myBoards([], saved), issue("PAY-101"))?.title).toBe("Card payment");
  });

  it("puts a removed board back where it was, and only once", () => {
    const saved = [
      { source: issue("PAY-101"), title: "", hidden: false },
      { source: issue("PAY-120"), title: "", kind: "story" as const, hidden: false },
      { source: { kind: "mine" } as Source, title: "", hidden: false },
    ];
    const entries = myBoards([queue("PAY")], saved);
    const removed = entries[2]!;
    const without = myBoards([queue("PAY")], togglePinned(entries, removed.source, removed.title));
    // Meanwhile another board moved to the end: it stays there.
    const moved = myBoards([queue("PAY")], moveBoard(without, "issue:PAY-101", null));
    const back = restoreBoard(moved, removed, "mine");
    expect(back.map((board) => board.source.kind === "issue" ? board.source.key : board.source.kind)).toEqual(["queue", "PAY-120", "mine", "PAY-101"]);
    expect(back[1]!.kind).toBe("story");
    expect(restoreBoard(myBoards([queue("PAY")], back), removed, "mine")).toHaveLength(4);
  });

  it("saves the boards alone without resetting other prefs", () => {
    expect(prefsPatchSchema.parse({ boards: [] })).toEqual({ boards: [] });
    expect(prefsSchema.parse({}).boardsReady).toBe(false);
  });
});
