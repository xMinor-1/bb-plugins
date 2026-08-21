// bb-plugin-usage-meter — backend: one poll of Claude limits per server.
//
// A background service asks bb.sdk.system.usageLimits() every five minutes and
// keeps the snapshot in memory. Every client reads that same snapshot through
// the `state` RPC method, so the number of tabs adds no load on the API.
//
// Realtime does not apply here: the rings are drawn by a content script, and
// the channel subscription lives only in the useRealtime React hook, out of a
// content script's reach. There would be nobody to publish to: the frontend
// polls `state` instead.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// The provider rate-limits the call itself: after an hour of polling once a
// minute it answered "Claude usage is rate limited right now". Limits move
// slowly, and five minutes is plenty.
/** Limit poll period. */
const POLL_MS = 5 * 60_000;
/** Backoff ceiling: after a failure the period doubles, but no further than half an hour. */
const RETRY_MAX_MS = 30 * 60_000;

// The package does not export the SDK response type (ProviderUsageResponse),
// but it can be inferred from the method signature — honest typing instead of any.
type UsageLimits = Awaited<
  ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>
>;
type ClaudeUsage = UsageLimits["claudeCode"];

const usageWindow = z.object({
  /** The API's English window label: "Current session", "Weekly limit", "Fable". */
  label: z.string(),
  usedPercent: z.number(),
  /** ISO reset time; the API is allowed not to know it. */
  resetsAt: z.string().nullable(),
});

const usageState = z.object({
  /** Provider statuses from the SDK plus "unknown" — no snapshot yet. */
  status: z.enum([
    "ok",
    "not_installed",
    "unauthenticated",
    "expired",
    "error",
    "unknown",
  ]),
  planLabel: z.string().nullable(),
  accountEmail: z.string().nullable(),
  windows: z.array(usageWindow),
  /** Error text from the provider, or from the call itself when it failed. */
  message: z.string().nullable(),
  /** When the snapshot was taken, ISO. null means no successful call yet. */
  fetchedAt: z.string().nullable(),
  /**
   * When the figures in `windows` were fresh, ISO. After a one-off failure the
   * figures stay on screen, and this time shows their age.
   */
  okAt: z.string().nullable(),
});

/** The snapshot the frontend sees. app.tsx imports these types only. */
export type UsageState = z.infer<typeof usageState>;
export type UsageWindow = z.infer<typeof usageWindow>;

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: usageState },
});

/** An empty snapshot until the first successful poll. */
const UNKNOWN: UsageState = {
  status: "unknown",
  planLabel: null,
  accountEmail: null,
  windows: [],
  message: null,
  fetchedAt: null,
  okAt: null,
};

/** Provider response → snapshot. Parsed strictly along the SDK's discriminated union. */
function toState(claude: ClaudeUsage, previous: UsageState): UsageState {
  const fetchedAt = new Date().toISOString();
  if (claude.status === "ok") {
    return {
      status: "ok",
      planLabel: claude.planLabel,
      accountEmail: claude.accountEmail,
      windows: claude.windows.map((window) => ({
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      })),
      message: null,
      fetchedAt,
      okAt: fetchedAt,
    };
  }
  if (claude.status === "error") {
    // A one-off failure: network, timeout, provider rate limiting. The previous
    // figures are honester than an empty ring — they stay, along with their age.
    return {
      status: "error",
      planLabel: claude.planLabel ?? previous.planLabel,
      accountEmail: claude.accountEmail ?? previous.accountEmail,
      windows: previous.windows,
      message: claude.message,
      fetchedAt,
      okAt: previous.okAt,
    };
  }
  // not_installed / unauthenticated / expired — the API reports neither plan
  // nor email, and the old figures are no longer about this account: clear it.
  return { ...UNKNOWN, status: claude.status, fetchedAt };
}

export default async function plugin(bb: BbPluginApi) {
  let current: UsageState = UNKNOWN;
  // Key of the last complaint written to the log: one and the same trouble is
  // logged once, or an unreachable provider would bury the log every minute.
  let complaint = "";
  // One call for everyone: parallel `state` requests before the first poll wait
  // for it rather than hitting the API again.
  let inFlight: Promise<UsageState> | null = null;

  async function refresh(signal?: AbortSignal): Promise<UsageState> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const usage = await bb.sdk.system.usageLimits(
          signal ? { signal } : undefined,
        );
        const next = toState(usage.claudeCode, current);
        const key = next.status === "ok" ? "" : `${next.status}:${next.message ?? ""}`;
        if (key !== complaint) {
          complaint = key;
          if (key) bb.log.info(`claude code: ${next.status}${next.message ? ` — ${next.message}` : ""}`);
        }
        current = next;
        return current;
      } catch (error) {
        // Cancelled by a reload or a stop — no trouble, and nothing to log.
        if (signal?.aborted) return current;
        // The call itself failed. Keep the previous snapshot, mark the error and
        // complain no more than once per distinct cause.
        const message = error instanceof Error ? error.message : String(error);
        if (message !== complaint) {
          complaint = message;
          bb.log.warn(`usageLimits failed: ${message}`);
        }
        // fetchedAt is set here too: otherwise every client seeing a snapshot
        // without a time would call refresh on its own.
        current = {
          ...current,
          status: "error",
          message,
          fetchedAt: new Date().toISOString(),
        };
        return current;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  bb.rpc.register(rpcContract, {
    // Serves the snapshot from memory. The first client to arrive before the
    // service gets the result of the shared poll, not its own API call.
    state: async () => (current.fetchedAt === null ? refresh() : current),
  });

  bb.background.service("poll", {
    async start(signal) {
      let delay = POLL_MS;
      while (!signal.aborted) {
        const next = await refresh(signal);
        // Rate-limited, or the network went down — back off further so as not to
        // pile on the provider; a successful poll restores the normal step.
        delay = next.status === "ok" ? POLL_MS : Math.min(delay * 2, RETRY_MAX_MS);
        // The sleep must wake on abort, or a plugin reload waits a minute and
        // ends up with "degraded (service did not stop)".
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });
}
