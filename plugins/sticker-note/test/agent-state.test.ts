import { describe, expect, it } from "vitest";

import { agentView, needsUser } from "../src/agent-state";
import type { Chat } from "../src/model";

const chat = (fields: Partial<Chat>): Chat => ({
  id: "x",
  text: "job",
  threadId: "t",
  error: null,
  createdAt: "2026-10-31T10:00:00.000Z",
  origin: "card",
  follow: true,
  status: "working",
  reply: null,
  replyAt: null,
  unread: false,
  ...fields,
});

describe("agent state on a card", () => {
  it("shows the most urgent chat", () => {
    const view = agentView({ chats: [chat({ id: "a", status: "working" }), chat({ id: "b", status: "waiting" })] });
    expect(view).toMatchObject({ state: "waiting", chat: { id: "b" } });
  });

  it("an answer seen is quiet", () => {
    expect(agentView({ chats: [chat({ status: "answered", unread: true })] })?.state).toBe("answered");
    expect(agentView({ chats: [chat({ status: "answered", unread: false })] })?.state).toBe("seen");
  });

  it("a chat the card was made from is only a link", () => {
    expect(agentView({ chats: [chat({ origin: "chat", follow: false, status: "answered" })] })?.state).toBe("linked");
  });

  it("asks for the user only on open cards", () => {
    const chats = [chat({ status: "waiting" })];
    expect(needsUser({ chats, done: false })).toBe(true);
    expect(needsUser({ chats, done: true })).toBe(false);
    expect(agentView({ chats: [] })).toBeNull();
  });
});
