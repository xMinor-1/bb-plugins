// Watches one thread's events and tells when the model itself has stopped
// moving. Pure logic: events and the clock come from outside.
//
// Only the model's own signals count: a reasoning or answer item that stays
// open too long, or a running turn with nothing open and no events at all.
// A tool call, a shell command or a pending approval that takes long is not the
// model's fault, and another model would wait for it the same way, so those
// never produce a verdict.

import type { FallbackReason } from "../shared/reason";

export interface TrackerEvent {
  seq: number;
  type: string;
  createdAt: number;
  data?: unknown;
}

export interface HangLimits {
  /** Minutes a reasoning item may stay open; 0 turns the check off. */
  thinkingMinutes: number;
  /** Minutes an answer item may stay open; 0 turns the check off. */
  answerMinutes: number;
  /** Minutes of no events at all with nothing open; 0 turns the check off. */
  silenceMinutes: number;
}

type OpenKind = "reasoning" | "answer" | "other";

const MINUTE = 60_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function itemOf(data: unknown): { id: string | null; type: string } {
  const item = record(record(data).item);
  return { id: typeof item.id === "string" ? item.id : null, type: typeof item.type === "string" ? item.type : "" };
}

function openKind(itemType: string): OpenKind {
  if (itemType === "reasoning") return "reasoning";
  if (itemType === "agentMessage") return "answer";
  return "other";
}

export class HangTracker {
  seq = 0;
  /** The turn's `client/turn/requested` id, once seen. */
  requestId: string | null = null;
  /** The model the turn was requested on, as `client/turn/requested` names it. */
  model: string | null = null;
  /** The provider accepted the turn: from here on silence is the model's. */
  started = false;
  done = false;
  lastEventAt: number;
  private readonly open = new Map<string, { at: number; kind: OpenKind }>();
  private readonly pending = new Set<string>();

  constructor(now: number) {
    this.lastEventAt = now;
  }

  feed(event: TrackerEvent): void {
    if (event.seq <= this.seq) return;
    this.seq = event.seq;
    this.lastEventAt = Math.max(this.lastEventAt, event.createdAt);
    const data = record(event.data);
    switch (event.type) {
      case "client/turn/requested": {
        // A new turn: everything before it is history.
        this.requestId = typeof data.requestId === "string" ? data.requestId : null;
        const model = record(data.execution).model;
        this.model = typeof model === "string" && model !== "" ? model : null;
        this.started = false;
        this.done = false;
        this.open.clear();
        this.pending.clear();
        this.lastEventAt = event.createdAt;
        return;
      }
      case "turn/started":
      case "turn/input/accepted":
        this.started = true;
        this.done = false;
        return;
      case "item/started": {
        const item = itemOf(event.data);
        if (item.id !== null) this.open.set(item.id, { at: event.createdAt, kind: openKind(item.type) });
        return;
      }
      case "item/completed": {
        const item = itemOf(event.data);
        if (item.id !== null) this.open.delete(item.id);
        return;
      }
      case "turn/completed":
      case "system/thread/interrupted":
      case "system/error":
        this.done = true;
        this.open.clear();
        this.pending.clear();
        return;
      case "system/interaction/lifecycle": {
        const interaction = record(data.interaction);
        const id = typeof interaction.id === "string" ? interaction.id : null;
        if (id === null) return;
        if (interaction.status === "pending") this.pending.add(id);
        else this.pending.delete(id);
        return;
      }
      default:
        return;
    }
  }

  /** Why the model looks stuck, or null while it is fine or not the model's turn. */
  verdict(now: number, limits: HangLimits): FallbackReason | null {
    if (!this.started || this.done || this.pending.size > 0) return null;
    let waitingOnTool = false;
    for (const item of this.open.values()) {
      const minutes = (now - item.at) / MINUTE;
      if (item.kind === "reasoning" && limits.thinkingMinutes > 0 && minutes >= limits.thinkingMinutes) {
        return { kind: "thinking", minutes: Math.max(1, Math.floor(minutes)) };
      }
      if (item.kind === "answer" && limits.answerMinutes > 0 && minutes >= limits.answerMinutes) {
        return { kind: "answering", minutes: Math.max(1, Math.floor(minutes)) };
      }
      if (item.kind === "other") waitingOnTool = true;
    }
    if (waitingOnTool || this.open.size > 0) return null;
    const silent = (now - this.lastEventAt) / MINUTE;
    if (limits.silenceMinutes > 0 && silent >= limits.silenceMinutes) {
      return { kind: "silent", minutes: Math.max(1, Math.floor(silent)) };
    }
    return null;
  }
}
