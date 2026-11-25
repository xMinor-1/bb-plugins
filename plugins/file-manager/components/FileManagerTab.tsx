// components/FileManagerTab.tsx — the File Manager as a panel tab.
//
// bb's panel launcher ("New tab" → Actions, beside Start terminal and Start
// side chat) opens these. They render the same body the nav panel renders —
// same listing, tree, uploads, downloads, context menus, keyboard map and
// dialogs — with two differences the surface itself handles: the folder lives
// in the panel session instead of the route (a panel tab has no route), and the
// title-bar actions ride in the toolbar instead (a panel tab has no title bar).
//
// Two registrations because bb keeps the two launchers apart: a thread's panel
// and the root New thread screen's panel. The file manager is still rooted at
// the user's home folder rather than at a thread, so the only thing `threadId`
// buys is the toolbar's jump into that thread's checkout (§10.3) — which is
// why the thread wrapper forwards it and the New thread wrapper cannot.
import type { ExperimentalThreadTabProps, PluginNewThreadPanelProps } from "@get-bb/plugin-sdk/app";

import { useLocalLocation } from "../hooks/useFmLocation";
import { FileManagerSurface } from "./FileManagerPanel";

function FileManagerTabBody({ sessionScope, threadId = null }: { sessionScope: string; threadId?: string | null }) {
  const location = useLocalLocation("", sessionScope);
  return <FileManagerSurface location={location} chrome="inline" threadId={threadId} sessionScope={sessionScope} />;
}

/** `experimental_tab` (thread action): the panel launcher of an existing thread. */
export function FileManagerTab({ threadId }: ExperimentalThreadTabProps) {
  const sessionScope = `thread:${threadId}`;
  return <FileManagerTabBody key={sessionScope} sessionScope={sessionScope} threadId={threadId} />;
}

/** `experimental_newThreadPanelAction`: the root New thread screen's launcher. */
export function FileManagerNewThreadTab({ projectId }: PluginNewThreadPanelProps) {
  // No thread has been created yet, so there is no workspace to jump into and
  // the toolbar shows no Thread folder button at all.
  const sessionScope = `new-thread:${projectId ?? ""}`;
  return <FileManagerTabBody key={sessionScope} sessionScope={sessionScope} />;
}
