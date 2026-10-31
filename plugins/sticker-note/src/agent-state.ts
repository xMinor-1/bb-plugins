// What a card shows about its agent chats: one state, the most urgent first.
import type { Card, Chat } from "./model";

export type AgentState = "waiting" | "answered" | "working" | "failed" | "seen" | "linked";

export interface AgentView {
  state: AgentState;
  chat: Chat;
}

const RANK: Record<AgentState, number> = { waiting: 0, answered: 1, working: 2, failed: 3, seen: 4, linked: 5 };

function stateOf(chat: Chat): AgentState {
  if (!chat.follow) return chat.error ? "failed" : "linked";
  switch (chat.status) {
    case "waiting":
      return "waiting";
    case "answered":
      return chat.unread ? "answered" : "seen";
    case "failed":
      return "failed";
    default:
      return "working";
  }
}

/** The chat that matters most on this card, or null when it has none. */
export function agentView(card: Pick<Card, "chats">): AgentView | null {
  let best: AgentView | null = null;
  for (const chat of card.chats) {
    const state = stateOf(chat);
    if (!best || RANK[state] < RANK[best.state] || (RANK[state] === RANK[best.state] && chat.createdAt > best.chat.createdAt)) {
      best = { state, chat };
    }
  }
  return best;
}

/** The chat the card talks to: the newest with a thread that did not fail. */
export function liveChat(card: Pick<Card, "chats">): Chat | null {
  return [...card.chats].reverse().find((ch) => ch.threadId !== null && ch.status !== "failed") ?? null;
}

/** Cards whose agent waits for the user or has an answer they have not seen. */
export function needsUser(card: Pick<Card, "chats" | "done">): boolean {
  const view = agentView(card);
  return !card.done && (view?.state === "waiting" || view?.state === "answered");
}
