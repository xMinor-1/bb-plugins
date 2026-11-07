// Why a thread is moved to another model. The server stores the code and the
// numbers; the page and the message to the agent turn them into words.

export type FallbackReason =
  | { kind: "rate-limit"; status: number | null }
  | { kind: "overloaded"; status: number | null }
  | { kind: "server-error"; status: number | null }
  | { kind: "timeout" }
  | { kind: "thinking"; minutes: number }
  | { kind: "answering"; minutes: number }
  | { kind: "silent"; minutes: number };

export type FailureKind = "rate-limit" | "overloaded" | "server-error" | "timeout";

/** One line in English: for the message to the agent, logs and the CLI. */
export function reasonText(reason: FallbackReason): string {
  const status = "status" in reason && reason.status !== null ? ` (HTTP ${reason.status})` : "";
  switch (reason.kind) {
    case "rate-limit":
      return `hit its rate limit${status}`;
    case "overloaded":
      return `is overloaded${status}`;
    case "server-error":
      return `returned a server error${status}`;
    case "timeout":
      return "timed out";
    case "thinking":
      return `kept thinking for ${reason.minutes} min without an answer`;
    case "answering":
      return `stopped in the middle of an answer for ${reason.minutes} min`;
    case "silent":
      return `sent nothing for ${reason.minutes} min`;
  }
}
