// Opens First run once per app launch while setup steps are left: a new
// person lands on it instead of on an empty new-thread screen. Only from the
// new-thread screen, and only once: a person who went to a thread, or came
// back to the new-thread screen later, is left where they are.
import { useEffect } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import { SETUP_SUBPATH } from "./setup-page";

const DONE_KEY = "fleet-kit.first-run-opened";
/** The decision waits this long for the setup state; a slower answer opens nothing. */
const WAIT_MS = 8_000;

/** Module-wide: a remount in the same page load (another window's overlay, a strict-mode double mount) asks nothing again. */
let asked = false;

function onceThisLaunch(): boolean {
  if (asked) return false;
  asked = true;
  try {
    if (window.sessionStorage.getItem(DONE_KEY) !== null) return false;
    window.sessionStorage.setItem(DONE_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

export function FirstRunRedirect() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  useEffect(() => {
    // The launch counts from the first mount wherever the app opened: a later visit to "/" is never taken over.
    if (!onceThisLaunch() || window.location.pathname !== "/") return;
    const started = Date.now();
    rpc.call("setup_status", { lang: "en" }).then(
      (setup) => {
        // Too late, or the person has gone somewhere: leave them there.
        if (Date.now() - started > WAIT_MS || window.location.pathname !== "/") return;
        // Not read yet with an address set: the build is coming, First run says so.
        const left = setup.configured ? !setup.complete : setup.manifestSet;
        if (left) navigate.toPluginPanel("status", { subPath: SETUP_SUBPATH, replace: true });
      },
      () => undefined,
    );
  }, [rpc, navigate]);
  return null;
}
