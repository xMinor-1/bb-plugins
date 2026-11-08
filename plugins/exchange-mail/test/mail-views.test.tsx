// @vitest-environment jsdom
//
// One sidebar item for mail and the calendar: the Mail / Calendar switch at
// the top, the calendar's own address, and the view used last at the root.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ConnectionStatus } from "../contract";
import type { rpcContract } from "../server";

const app = await loadPluginApp(() => import("../app"));
const { MailPage, VIEW_KEY, viewOf } = await import("../src/app/MailPage");
const { setLang } = await import("../lib/i18n");

const READY: ConnectionStatus = {
  platform: "darwin",
  curl: { path: "/usr/bin/curl", version: "8.7.1", negotiate: true, ntlm: true },
  curlError: null,
  url: "https://mail.example.com/EWS/Exchange.asmx",
  auth: "negotiate",
  user: null,
  hasPassword: false,
  passwordStore: "Keychain",
  blocked: null,
  retryAt: null,
  lastCheck: { ok: true, at: 1, message: "Connected." },
};

const handlers = {
  machines: () => ({ machines: [{ id: "host_1", name: "Mac", connected: true }], lastUsed: "host_1", suggestedUrl: "" }),
  status: () => READY,
  list: () => ({ messages: [], total: 0, more: false, unread: 0 }),
  calendar: () => ({ events: [], more: false }),
} as unknown as PluginRpcTestHandlers<typeof rpcContract>;

function render(subPath: string) {
  return renderSlot({ component: MailPage }, { subPath }, { rpc: handlers });
}
const asked = (slot: ReturnType<typeof render>, method: string) => slot.inspection.rpcCalls.some((call) => call.method === method);

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  act(() => setLang(null));
});

describe("the sidebar item", () => {
  it("is one Mail panel at the old mail address", () => {
    expect(app.navPanels.map((panel) => ({ id: panel.id, path: panel.path }))).toEqual([{ id: "mail", path: "mail" }]);
  });

  it("reads the view from the subPath", () => {
    expect(viewOf("")).toBeNull();
    expect(viewOf("calendar")).toBe("calendar");
    expect(viewOf("calendar/2026-11-02")).toBe("calendar");
    expect(viewOf("inbox")).toBe("mail");
  });
});

describe("the Mail / Calendar switch", () => {
  it("opens mail at the root the first time", async () => {
    const slot = render("");
    await waitFor(() => expect(asked(slot, "list")).toBe(true));
    expect(screen.getByRole("button", { name: "Mail" }).getAttribute("aria-pressed")).toBe("true");
    expect(asked(slot, "calendar")).toBe(false);
  });

  it("switches to the calendar, moves the address and remembers it", async () => {
    const slot = render("");
    fireEvent.click(await screen.findByRole("button", { name: "Calendar" }));
    await waitFor(() => expect(asked(slot, "calendar")).toBe(true));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "mail", options: { subPath: "calendar" } });
    expect(localStorage.getItem(VIEW_KEY)).toBe("calendar");
    // The mail folders belong to the mail view only.
    expect(screen.queryByRole("button", { name: "Inbox" })).toBeNull();
  });

  it("opens the view used last at the root", async () => {
    localStorage.setItem(VIEW_KEY, "calendar");
    const slot = render("");
    await waitFor(() => expect(asked(slot, "calendar")).toBe(true));
    expect(asked(slot, "list")).toBe(false);
  });

  it("opens the calendar at its own address and remembers it", async () => {
    const slot = render("calendar");
    await waitFor(() => expect(asked(slot, "calendar")).toBe(true));
    expect(localStorage.getItem(VIEW_KEY)).toBe("calendar");
  });

  it("speaks Russian", async () => {
    act(() => setLang("ru"));
    render("");
    expect(await screen.findByRole("button", { name: "Календарь" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Почта" })).toBeTruthy();
  });
});
