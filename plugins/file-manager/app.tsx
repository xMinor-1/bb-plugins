// app.tsx — frontend entry point.
//
// One nav panel, registered exactly as §10 of SPEC.md prescribes. `id` and
// `path` must match /^[a-zA-Z0-9_-]+$/ or the whole frontend fails to
// register, and `icon` must agree with `bb.branding.icon` in package.json
// (which overrides it on compact surfaces). `experimental_fixedTabs` is
// deliberately absent in v0.1: only the active fixed tab is mounted, so
// closing the panel would strand the tree state.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { PANEL_PATH } from "./contract";
import { FileManagerPanel } from "./components/FileManagerPanel";
import { HeaderActions } from "./components/HeaderActions";
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
});
