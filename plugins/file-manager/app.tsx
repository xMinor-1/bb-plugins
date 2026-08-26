// app.tsx — frontend entry point.
//
// One nav panel, registered exactly as §10 of SPEC.md prescribes. `id` and
// `path` must match /^[a-zA-Z0-9_-]+$/ or the whole frontend fails to
// register, and `icon` must agree with `bb.branding.icon` in package.json
// (which overrides it on compact surfaces). `fixedTabs` is
// deliberately absent in v0.1: only the active fixed tab is mounted, so
// closing the panel would strand the tree state.
//
// Plus one settings section (v0.3): bb's declarative settings form has no path
// descriptor type, so `startFolder` would otherwise only be typeable by hand.
// The section renders the real folder browser over the same setting.
//
// Plus the two panel-launcher actions (v0.5): the same file manager, opened as
// a tab in the right-hand panel from "New tab" → Actions, beside Start
// terminal and Start side chat (§10.1). `layout: "flush"` because the body
// owns its own scrolling and needs a definite height for the listing.
//
// Plus the two file openers (v0.6): "Open with File location" in the
// right-click menu of a file link reveals that file in the side panel, and the
// preview wrapper keeps the automatic per-extension pick looking like bb's own
// preview (§10.2).
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { LOCATION_OPENER_EXTENSIONS, PANEL_PATH } from "./contract";
import { FileManagerPanel } from "./components/FileManagerPanel";
import { FileLocationOpener, FilePreviewOpener } from "./components/FileLocationOpener";
import { FileManagerNewThreadTab, FileManagerTab } from "./components/FileManagerTab";
import { HeaderActions } from "./components/HeaderActions";
import { SettingsSection } from "./components/SettingsSection";
import { SidebarAccessory } from "./components/SidebarAccessory";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "file-manager",
    title: "File Manager",
    icon: "FolderOpen",
    path: PANEL_PATH, // "files" → /plugins/file-manager/files/*
    component: FileManagerPanel,
    headerContent: HeaderActions,
    experimental_sidebarAccessory: SidebarAccessory,
  });

  // Rendered on the plugin's detail page, below the host-rendered descriptor
  // form (which keeps `bb plugin config file-manager set startFolder …` and the
  // plain text field working).
  app.slots.settingsSection({
    id: "start-folder",
    title: "Start folder",
    description: "Pick the folder the File Manager panel opens in.",
    component: SettingsSection,
  });

  // The thread panel's launcher. `run` is omitted on purpose: there is nothing
  // to resolve before opening, so the host opens the tab with the defaults.
  app.slots.threadPanelAction({
    id: "file-manager",
    title: "File Manager",
    icon: "FolderOpen",
    layout: "flush",
    component: FileManagerTab,
  });

  // The same action on the root New thread screen, which bb keeps as a
  // separate slot from the thread one.
  app.slots.experimental_newThreadPanelAction({
    id: "file-manager",
    title: "File Manager",
    icon: "FolderOpen",
    layout: "flush",
    component: FileManagerNewThreadTab,
  });

  // Right-clicking a file link in a message lists every matching opener as
  // "Open with <title>" — but bb also picks one AUTOMATICALLY per extension,
  // and that pick is the first registration that matches. So the preview
  // wrapper is registered first: a plain click still shows the file, with one
  // strip on top that reveals it. Order here is load-bearing (§10.2).
  app.slots.fileOpener({
    id: "preview",
    title: "Preview + location",
    extensions: [...LOCATION_OPENER_EXTENSIONS],
    component: FilePreviewOpener,
  });

  app.slots.fileOpener({
    id: "location",
    title: "File location",
    extensions: [...LOCATION_OPENER_EXTENSIONS],
    component: FileLocationOpener,
  });
});
