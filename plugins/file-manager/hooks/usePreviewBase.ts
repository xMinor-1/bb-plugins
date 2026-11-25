// hooks/usePreviewBase.ts — the gallery's thumbnail transport (§8.9).
//
// One `createPreviewUrl` per folder, renewed just before it lapses. The URL is
// folder-rooted, so a file uploaded into the folder while the gallery is open
// is covered by the URL already on hand — no refetch on every `fs` signal.
import { useEffect, useState } from "react";

import { useFmRpc } from "../lib/fm-rpc";

/** Renew this long before the server's expiry, so no tile races the clock. */
const RENEW_MARGIN_MS = 30_000;
/** Floor for the renewal timer: a server with a tiny TTL must not spin. */
const MIN_RENEW_DELAY_MS = 5_000;

interface PreviewBase {
  path: string;
  hostId: string | undefined;
  retry: number;
  /** null when the server has no preview transport — tiles fall back to icons. */
  baseUrl: string | null;
}

export interface UsePreviewBaseArgs {
  /** Absolute folder the URL must cover. */
  path: string;
  /** False while the gallery is off screen: no RPC at all. */
  enabled: boolean;
  /** A connected machine, or the local preview transport when omitted. */
  hostId?: string;
  /** Keep a media player's source stable. It can request a new grant on retry. */
  renew?: boolean;
  retry?: number;
}

/**
 * Base URL for `path`, or null while it is unknown — which covers both "still
 * loading" and "this server cannot mint one". Both render the same way, so the
 * caller never has to tell them apart.
 */
export function usePreviewLease({ path, enabled, hostId, renew = true, retry = 0 }: UsePreviewBaseArgs): PreviewBase | null {
  const rpc = useFmRpc();
  const [base, setBase] = useState<PreviewBase | null>(null);
  /** Bumped by the renewal timer; the effect below is the only fetcher. */
  const [renewal, setRenewal] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | null = null;
    void (async () => {
      try {
        const result = hostId === undefined
          ? await rpc.call("createPreviewUrl", { path })
          : await rpc.call("remotePreview", { hostId, path }).then((lease) => {
            if (lease.path !== path) throw new Error("Remote folder changed before preview");
            return lease;
          });
        if (cancelled) return;
        setBase({ path, hostId, retry, baseUrl: result.baseUrl });
        if (!renew) return;
        // A renewal swaps every `src` on screen, so it is scheduled as late as
        // the margin allows rather than on a fixed interval.
        const delay = Math.max(
          MIN_RENEW_DELAY_MS,
          result.expiresAtMs - Date.now() - RENEW_MARGIN_MS,
        );
        timer = window.setTimeout(() => setRenewal((count) => count + 1), delay);
      } catch {
        // Silent on purpose: thumbnails are decoration, and a toast per folder
        // would punish everyone whose server predates the preview transport.
        // Remembered per path so a re-render does not re-ask.
        if (!cancelled) setBase({ path, hostId, retry, baseUrl: null });
      }
    })();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, hostId, path, renew, renewal, retry, rpc]);

  // Never hand out another folder's URL: between a navigation and the new
  // answer landing, `base` still holds the folder the user just left.
  return enabled && base !== null && base.path === path && base.hostId === hostId && base.retry === retry
    ? base
    : null;
}

export function usePreviewBase(args: UsePreviewBaseArgs): string | null {
  return usePreviewLease(args)?.baseUrl ?? null;
}
