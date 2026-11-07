// What the plugin knows about one thread. The server keeps it in kv; the page
// reads it over RPC and turns codes into words. No imports from the SDK: the
// page bundle imports this file.

import type { FallbackReason } from "./reason";

/** Why the plugin left a failed turn alone. */
export type NotSwitchedWhy = "auth" | "connection" | "request" | "unknown";

export interface ModelRef {
  /** The id bb and the provider use, e.g. `corp/coder`. */
  id: string;
  /** The name people see in the model picker. */
  name: string;
}

export interface PendingSwitch {
  /** The turn this switch is about. */
  requestId: string;
  provider: string;
  from: ModelRef;
  to: ModelRef;
  reason: FallbackReason;
  trigger: "failure" | "hang";
  /** The original request never reached the model: send it again on `to`. */
  resend: boolean;
  createdAt: number;
  /** When the switch runs by itself; null once the person cancelled it. */
  dueAt: number | null;
}

export interface ActiveFallback {
  /** The model the thread ran on before the first switch: what Return gives back. */
  original: ModelRef;
  current: ModelRef;
  reason: FallbackReason;
  at: number;
}

export type Notice =
  | { kind: "no-fallback"; requestId: string; model: ModelRef; reason: FallbackReason; at: number }
  | { kind: "not-switched"; requestId: string; model: ModelRef; why: NotSwitchedWhy; at: number };

export type LogEntry =
  | { kind: "switched"; at: number; from: ModelRef; to: ModelRef; reason: FallbackReason }
  | { kind: "cancelled"; at: number; from: ModelRef; to: ModelRef; reason: FallbackReason }
  | { kind: "returned"; at: number; to: ModelRef }
  | { kind: "no-fallback"; at: number; model: ModelRef; reason: FallbackReason }
  | { kind: "not-switched"; at: number; model: ModelRef; why: NotSwitchedWhy }
  | { kind: "recovered"; at: number; model: ModelRef }
  | { kind: "failed"; at: number; from: ModelRef; to: ModelRef; error: string };

/** One continuation message the plugin sent, for the label above it in the timeline. */
export interface SentMessage {
  /** `createdAt` of its `client/turn/requested` event. */
  at: number;
  from: ModelRef;
  to: ModelRef;
}

export interface ThreadState {
  pending: PendingSwitch | null;
  active: ActiveFallback | null;
  notice: Notice | null;
  log: LogEntry[];
  sent: SentMessage[];
  /** Turns the plugin sent, so their own requests are not taken for the person's choice. */
  ownRequests: string[];
}

export const MAX_LOG = 20;
export const MAX_SENT = 20;

export function emptyState(): ThreadState {
  return { pending: null, active: null, notice: null, log: [], sent: [], ownRequests: [] };
}

/** What the page shows: the state plus the ladder the thread is on. */
export interface ThreadView {
  state: ThreadState;
  /** The thread's ladder as names, when its current model is on one. */
  ladder: ModelRef[] | null;
  now: number;
}

/** Realtime channel: payload `{ threadId }`. */
export const THREAD_CHANGED = "thread-changed";

/** How far a timeline message may be from the request it belongs to. */
export const SENT_MATCH_MS = 5_000;
