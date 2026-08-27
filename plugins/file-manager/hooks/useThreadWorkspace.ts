// hooks/useThreadWorkspace.ts — "where does this thread's code live?" (§10.3).
//
// The panel tab is the one surface bb names a thread for, so it is the one
// surface that can offer a jump into that thread's checkout. The answer is a
// backend lookup (thread → environment → checkout) with three ordinary "no"
// answers — no environment, no checkout, a checkout outside the home folder —
// which are states the toolbar renders, not errors it raises.
//
// The lookup runs on mount rather than on click, because the toolbar has to
// know whether to offer the jump *before* the user reaches for it. A lookup
// that failed outright is the one state that stays clickable: "bb did not
// answer" is not "there is nowhere to go", so the click retries it.
import { useCallback, useEffect, useRef, useState } from "react";

import type { ThreadWorkspaceReason } from "../contract";
import { parseRpcError } from "../lib/errors";
import { useFmRpc } from "../lib/fm-rpc";

export type ThreadWorkspaceState =
  /** This surface has no thread at all: there is nothing to offer. */
  | { status: "absent" }
  | { status: "loading" }
  | { status: "ready"; path: string }
  | { status: "blocked"; reason: ThreadWorkspaceReason }
  | { status: "failed"; message: string };

export interface UseThreadWorkspaceResult {
  state: ThreadWorkspaceState;
  /** Re-runs the lookup and resolves to whatever it settled on. */
  reload(): Promise<ThreadWorkspaceState>;
}

/**
 * Why the jump is off, phrased for the control that has to say so.
 *
 * The prefix is deliberate: these read as one disabled row in an overflow menu
 * of unrelated actions, and "this thread has no workspace" on its own does not
 * say which action it is talking about.
 */
export function threadWorkspaceBlockedText(reason: ThreadWorkspaceReason): string {
  switch (reason) {
    case "no_environment":
      return "Thread folder: this thread has no workspace";
    case "no_checkout":
      return "Thread folder: the workspace has no folder yet";
    case "outside_root":
      return "Thread folder: outside your home folder";
  }
}

const ABSENT: ThreadWorkspaceState = { status: "absent" };
const LOADING: ThreadWorkspaceState = { status: "loading" };

/** An answer, tagged with the thread it is an answer about. */
interface Answered {
  threadId: string | null;
  state: ThreadWorkspaceState;
}

export function useThreadWorkspace(threadId: string | null): UseThreadWorkspaceResult {
  const rpc = useFmRpc();
  const [answered, setAnswered] = useState<Answered>({ threadId, state: ABSENT });
  /** False after unmount, so a late answer cannot set state on a dead tree. */
  const liveRef = useRef(true);
  /** Only the newest lookup may write: a retry can overtake the first call. */
  const ticketRef = useRef(0);

  // Derived rather than stored for the two states that need no lookup, so a
  // surface with no thread costs zero extra renders. That is not a micro-
  // optimization: the panel's first paint is a skeleton, and one stray commit
  // between `getState` landing and `listDir` starting is enough to flash "this
  // folder is empty" at the user. Tagging the answer with its thread is what
  // keeps a previous thread's answer from being shown for a new one.
  const state: ThreadWorkspaceState =
    answered.threadId === threadId ? answered.state : threadId === null ? ABSENT : LOADING;

  const lookup = useCallback(
    async (id: string): Promise<ThreadWorkspaceState> => {
      const ticket = (ticketRef.current += 1);
      if (liveRef.current) setAnswered({ threadId: id, state: LOADING });

      let next: ThreadWorkspaceState;
      try {
        const answer = await rpc.call("threadWorkspace", { threadId: id });
        if (answer.reason === null && answer.path !== null) {
          next = { status: "ready", path: answer.path };
        } else {
          // `reason` is null only when a path came back, so the fallback here
          // is for a backend that broke its own invariant, not a real state.
          next = { status: "blocked", reason: answer.reason ?? "no_checkout" };
        }
      } catch (failure) {
        next = { status: "failed", message: parseRpcError(failure).rawMessage };
      }

      if (liveRef.current && ticket === ticketRef.current) {
        setAnswered({ threadId: id, state: next });
      }
      return next;
    },
    [rpc],
  );

  useEffect(() => {
    liveRef.current = true;
    if (threadId !== null) void lookup(threadId);
    return () => {
      liveRef.current = false;
    };
  }, [lookup, threadId]);

  const reload = useCallback(async (): Promise<ThreadWorkspaceState> => {
    if (threadId === null) return ABSENT;
    return lookup(threadId);
  }, [lookup, threadId]);

  return { state, reload };
}
