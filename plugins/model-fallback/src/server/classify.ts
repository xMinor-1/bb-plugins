// Which turn failures another model can fix.
//
// Switch: the model refused or broke on its side — a rate limit, overload,
// a 5xx from the model server, a model that timed out.
// Do not switch: the request never reached any model (no network, no VPN,
// DNS), the key was refused, or the request itself was wrong. Another model
// behind the same door fails the same way, and a switch would only walk the
// thread down its ladder for nothing.

import type { FallbackReason } from "../shared/reason";

export interface FailureFacts {
  /** `errorInfo.category` from the turn.failed event, when core had one. */
  category: string | null;
  httpStatusCode: number | null;
  /** The provider's error text: `provider/error` detail or the thread's last error. */
  text: string;
}

export type FailureVerdict =
  | { switch: true; reason: FallbackReason }
  | { switch: false; why: "auth" | "connection" | "request" | "unknown" };

const MAX_TEXT = 4000;

// Each pattern starts with a fixed word, so matching stays linear in the text.
const AUTH = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid api key|authentication/i;
const CONNECTION =
  /\b(?:ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b|getaddrinfo|unable to connect|cannot connect to api|connection refused/i;
const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|quota exceeded/i;
const OVERLOADED = /overloaded|no_available_workers|circuits? (?:is |are )?open|over capacity|server is busy/i;
const SERVER_STATUS = /\b(50[0-4])\b/;
const TIMEOUT = /timed out|\btimeout\b|ETIMEDOUT|deadline exceeded/i;

export function classifyFailure(facts: FailureFacts): FailureVerdict {
  const text = facts.text.slice(0, MAX_TEXT);
  const status = facts.httpStatusCode;
  const category = facts.category;

  if (status === 401 || status === 403 || category === "authentication" || category === "auth") {
    return { switch: false, why: "auth" };
  }
  if (status === 429 || category === "rate-limit") return { switch: true, reason: { kind: "rate-limit", status } };
  if (category === "overloaded" || status === 529) return { switch: true, reason: { kind: "overloaded", status } };
  if (status !== null && status >= 500 && status <= 504) {
    return { switch: true, reason: { kind: "server-error", status } };
  }
  if (category === "connection-failed") return { switch: false, why: "connection" };

  // The structured facts did not settle it: read the provider's own words.
  if (AUTH.test(text)) return { switch: false, why: "auth" };
  if (CONNECTION.test(text)) return { switch: false, why: "connection" };
  if (RATE_LIMIT.test(text)) return { switch: true, reason: { kind: "rate-limit", status: status ?? statusIn(text, 429) } };
  if (OVERLOADED.test(text)) return { switch: true, reason: { kind: "overloaded", status: status ?? serverStatus(text) } };
  const server = serverStatus(text);
  if (server !== null) return { switch: true, reason: { kind: "server-error", status: server } };
  if (TIMEOUT.test(text)) return { switch: true, reason: { kind: "timeout" } };
  if (status !== null && status >= 400 && status < 500) return { switch: false, why: "request" };
  return { switch: false, why: "unknown" };
}

function statusIn(text: string, code: number): number | null {
  return new RegExp(`\\b${code}\\b`).test(text) ? code : null;
}

function serverStatus(text: string): number | null {
  const match = SERVER_STATUS.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}
