import { describe, expect, it } from "vitest";
import { HangTracker, type TrackerEvent } from "../src/server/tracker";

const MIN = 60_000;
const limits = { thinkingMinutes: 7, answerMinutes: 6, silenceMinutes: 7 };

function run(events: Array<[number, string, unknown?]>): HangTracker {
  const tracker = new HangTracker(0);
  events.forEach(([at, type, data], index) => tracker.feed({ seq: index + 1, type, createdAt: at, data } as TrackerEvent));
  return tracker;
}

const requested = (model = "corp/coder") => ({ requestId: "creq_1", execution: { model } });
const item = (id: string, type: string) => ({ item: { id, type } });

describe("HangTracker", () => {
  it("knows the turn's request and model", () => {
    const tracker = run([[0, "client/turn/requested", requested("corp/daily")]]);
    expect(tracker.requestId).toBe("creq_1");
    expect(tracker.model).toBe("corp/daily");
  });

  it("flags reasoning and an answer that stay open too long", () => {
    const thinking = run([[0, "client/turn/requested", requested()], [1, "turn/started"], [2, "item/started", item("r1", "reasoning")]]);
    expect(thinking.verdict(6 * MIN, limits)).toBeNull();
    expect(thinking.verdict(7 * MIN + 5, limits)).toEqual({ kind: "thinking", minutes: 7 });

    const answering = run([[0, "client/turn/requested", requested()], [1, "turn/started"], [2, "item/started", item("a1", "agentMessage")]]);
    expect(answering.verdict(6 * MIN + 5, limits)).toEqual({ kind: "answering", minutes: 6 });
  });

  it("flags silence only after the provider took the turn", () => {
    const provisioning = run([[0, "client/turn/requested", requested()], [1, "system/thread-provisioning"]]);
    expect(provisioning.verdict(30 * MIN, limits)).toBeNull();

    const silent = run([
      [0, "client/turn/requested", requested()],
      [1, "turn/started"],
      [2, "item/started", item("t1", "toolCall")],
      [3 * MIN, "item/completed", item("t1", "toolCall")],
    ]);
    expect(silent.verdict(9 * MIN, limits)).toBeNull();
    expect(silent.verdict(10 * MIN, limits)).toEqual({ kind: "silent", minutes: 7 });
  });

  it("never blames the model for a slow tool, command or a pending approval", () => {
    const command = run([[0, "client/turn/requested", requested()], [1, "turn/started"], [2, "item/started", item("c1", "commandExecution")]]);
    expect(command.verdict(60 * MIN, limits)).toBeNull();

    const approval = run([
      [0, "client/turn/requested", requested()],
      [1, "turn/started"],
      [2, "system/interaction/lifecycle", { interaction: { id: "i1", status: "pending" } }],
    ]);
    expect(approval.verdict(60 * MIN, limits)).toBeNull();
  });

  it("is quiet once the turn is over and starts fresh on the next one", () => {
    const tracker = run([
      [0, "client/turn/requested", requested()],
      [1, "turn/started"],
      [2, "item/started", item("r1", "reasoning")],
      [3, "turn/completed", { status: "completed" }],
    ]);
    expect(tracker.verdict(60 * MIN, limits)).toBeNull();
    tracker.feed({ seq: 10, type: "client/turn/requested", createdAt: 61 * MIN, data: { requestId: "creq_2", execution: { model: "corp/fast" } } });
    expect(tracker.requestId).toBe("creq_2");
    expect(tracker.verdict(70 * MIN, limits)).toBeNull();
  });

  it("turns a check off with 0 minutes", () => {
    const tracker = run([[0, "client/turn/requested", requested()], [1, "turn/started"], [2, "item/started", item("r1", "reasoning")]]);
    expect(tracker.verdict(60 * MIN, { thinkingMinutes: 0, answerMinutes: 0, silenceMinutes: 0 })).toBeNull();
  });
});
