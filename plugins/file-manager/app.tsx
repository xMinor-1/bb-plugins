// app.tsx — frontend entry point.
//
// One nav panel, registered exactly as §10 of SPEC.md prescribes. `id` and
// `path` must match /^[a-zA-Z0-9_-]+$/ or the whole frontend fails to
// register, and `icon` must agree with `bb.branding.icon` in package.json
// (which overrides it on compact surfaces). `experimental_fixedTabs` is
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
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { PANEL_PATH } from "./contract";
import { FileManagerPanel } from "./components/FileManagerPanel";
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
});
