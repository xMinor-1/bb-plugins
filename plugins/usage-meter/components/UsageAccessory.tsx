// components/UsageAccessory.tsx — the trailing edge of the plugin's sidebar row.
//
// Two jobs, both small. It prints the session limit next to the page's name, so
// the number is readable even when the sidebar covers the footer rings. And,
// because it is React and it is mounted whenever bb draws that row, it parks a
// navigate function for the content script, which has no hooks of its own and
// would otherwise have to reload the whole app to open the page.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";

import type { rpcContract, UsageWindow } from "../server";
import { PANEL_PATH, SESSION_LABEL, findWindow, percentOf, resetText } from "../lib/limits";
import { setPanelOpener } from "../lib/panel-link";
import { toneOf } from "./ui";

/** The snapshot is shared and cheap; a minute is as often as it changes. */
const POLL_MS = 60_000;

const TONE_CLASS = {
  normal: "text-muted-foreground",
  warn: "text-amber-500",
  danger: "text-destructive",
} as const;

export function UsageAccessory(): ReactNode {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [session, setSession] = useState<UsageWindow | null>(null);

  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useEffect(() => {
    setPanelOpener((subPath) =>
      navigate.toPluginPanel(PANEL_PATH, subPath === undefined ? undefined : { subPath }),
    );
    return () => setPanelOpener(null);
  }, [navigate]);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async (): Promise<void> => {
      try {
        const state = await rpcRef.current.call("state", null);
        if (!alive) return;
        setSession(findWindow(state, SESSION_LABEL));
      } catch {
        // The sidebar is no place for an error message: keep the last figure.
      }
      if (alive) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  const percent = percentOf(session);
  if (percent === null) return null;
  // A bare "29%" in a sidebar row says nothing: the popup next to it holds three
  // such figures (session, week, per-model), so which one this is cannot be
  // guessed, and a screen reader would announce nothing but "29 per cent".
  const spoken = `${SESSION_LABEL} limit ${Math.round(percent)}%`;
  const reset = resetText(session?.resetsAt ?? null);
  return (
    <span
      title={reset ? `${spoken} · ${reset}` : spoken}
      aria-label={spoken}
      className={`text-xs tabular-nums ${TONE_CLASS[toneOf(percent)]}`}
    >
      {Math.round(percent)}%
    </span>
  );
}
