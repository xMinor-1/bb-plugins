// @vitest-environment jsdom
//
// §10 — the nav panel registration is verbatim law: `id` and `path` must match
// /^[a-zA-Z0-9_-]+$/ or the whole frontend fails to register, and `icon` must
// agree with `bb.branding.icon` in package.json (which overrides it on compact
// surfaces). This suite is the only guard against a silent rename.
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

import { PANEL_PATH } from "../../contract";

// Every plugin module that touches `@get-bb/plugin-sdk/app` binds the runtime
// at import time, so it may only be imported *after* loadPluginApp installed
// the test runtime — hence the dynamic imports here (see the SDK's
// installTestPluginRuntime docs).
const app = await loadPluginApp(() => import("../../app"));
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");

beforeEach(() => {
  resetUploadManager();
  resetPanelSnapshot();
});

afterEach(cleanup);

describe("nav panel registration (§10)", () => {
  it("registers exactly one navPanel with the spec'd id / title / icon / path", () => {
    expect(app.navPanels).toHaveLength(1);
    const panel = app.navPanels[0];
    expect(panel).toBeDefined();
    expect({
      id: panel?.id,
      title: panel?.title,
      icon: panel?.icon,
      path: panel?.path,
    }).toEqual({
      id: "file-manager",
      title: "File Manager",
      icon: "FolderOpen",
      path: "files",
    });
    expect(panel?.path).toBe(PANEL_PATH);
    expect(panel?.id).toMatch(/^[a-zA-Z0-9_-]+$/u);
    expect(panel?.path).toMatch(/^[a-zA-Z0-9_-]+$/u);
  });

  it("wires the panel body, the title-bar slot and the sidebar accessory", () => {
    const panel = app.navPanels[0];
    expect(panel?.component).toBeTypeOf("function");
    expect(panel?.headerContent).toBeTypeOf("function");
    expect(panel?.experimental_sidebarAccessory).toBeTypeOf("function");
  });

  it("does not register experimental_fixedTabs in v0.1 (§10: it strands tree state)", () => {
    expect(app.navPanels[0]?.experimental_fixedTabs).toBeUndefined();
  });

  it("registers no other frontend slots", () => {
    expect(app.homepageSections).toHaveLength(0);
    expect(app.settingsSections).toHaveLength(0);
    expect(app.threadPanelActions).toHaveLength(0);
    expect(app.composerCustomizations).toHaveLength(0);
    expect(app.contentScripts).toHaveLength(0);
  });

  it("renders nothing in the sidebar accessory while no upload is running", async () => {
    const Accessory = app.navPanels[0]?.experimental_sidebarAccessory;
    const slot = renderSlot({ component: Accessory! }, {}, { rpc: {} });
    await waitFor(() => {
      expect(slot.container.textContent).toBe("");
    });
    expect(slot.queryByTestId("fm-sidebar-accessory")).toBeNull();
  });
});
