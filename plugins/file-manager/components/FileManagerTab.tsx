// components/FileManagerTab.tsx — the File Manager as a panel tab.
//
// bb's panel launcher ("New tab" → Actions, beside Start terminal and Start
// side chat) opens these. They render the same body the nav panel renders —
// same listing, tree, uploads, downloads, context menus, keyboard map and
// dialogs — with two differences the surface itself handles: the folder lives
// in component state instead of the route (a panel tab has no route), and the
// title-bar actions ride in the toolbar instead (a panel tab has no title bar).
//
// Two registrations because bb keeps the two launchers apart: a thread's panel
// and the root New thread screen's panel. Neither prop is read — the file
// manager is rooted at the user's home folder, not at a thread or a project —
// but the host types them, so both wrappers exist to name that explicitly.
import type { PluginNewThreadPanelProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";

import { useLocalLocation } from "../hooks/useFmLocation";
import { FileManagerSurface } from "./FileManagerPanel";

function FileManagerTabBody() {
  // Starts at the root and lets the bootstrap redirect to the remembered or
  // configured folder, exactly as the nav panel does on a cold open (§1.5).
  const location = useLocalLocation("");
  return <FileManagerSurface location={location} chrome="inline" />;
}

/** `threadPanelAction`: the panel launcher of an existing thread. */
export function FileManagerTab(_props: PluginThreadPanelProps) {
  return <FileManagerTabBody />;
}

/** `experimental_newThreadPanelAction`: the root New thread screen's launcher. */
export function FileManagerNewThreadTab(_props: PluginNewThreadPanelProps) {
  return <FileManagerTabBody />;
}
