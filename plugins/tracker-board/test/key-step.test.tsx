// @vitest-environment jsdom
// Without a key the page asks for one first, with the build's hint on where to get it.
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageMode } from "../src/app/Boards";
import { helpParts, KeyStep } from "../src/app/KeyStep";
import { messages } from "../src/app/messages";
import { Icons } from "../src/app/parts";
import { hasKeyStore, type Rpc } from "../src/app/store";
import { prefsSchema, type Source } from "../src/shared/prefs";
import type { ConfigView } from "../src/server/rpc-contract";

const queue = (key: string): Source => ({ kind: "queue", queue: key });
const config = (over: Partial<ConfigView> = {}) =>
  ({ defaultBoards: [queue("PAY")], allowQuery: false, problem: null, keyHelp: null, can: { queues: true, mine: true }, ...over }) as unknown as ConfigView;
const fresh = prefsSchema.parse({});
const chosen = prefsSchema.parse({ boardsReady: true, source: queue("PAY"), boards: [{ source: queue("PAY"), title: "Payments" }] });
const help = "Profile → API keys: https://tracker.example.com/settings/keys. Ask the team lead if the page is empty.";

/** A fake page rpc: saveKey answers with `answer`, every call is recorded. */
function fakeRpc(answer: { ok: boolean; code: string | null }) {
  const call = vi.fn(async (name: string) => (name === "saveKey" ? { ...answer, me: null } : null));
  return { rpc: { call } as unknown as Rpc, call };
}

afterEach(() => {
  cleanup();
  hasKeyStore.set(null);
});

describe("what the page shows", () => {
  it("asks for the key first, even when boards were picked on an earlier visit", () => {
    expect(pageMode(config(), chosen, false, false)).toBe("key");
    expect(pageMode(config(), fresh, false, false)).toBe("key");
  });

  it("goes on to the first-run step or the board once the key is there", () => {
    expect(pageMode(config(), fresh, true, false)).toBe("interest");
    expect(pageMode(config(), chosen, true, false)).toBe("board");
  });

  it("does not hold the page when the key state is unknown or the build is broken", () => {
    expect(pageMode(config(), chosen, null, false)).toBe("board");
    expect(pageMode(config({ problem: "The tracker address is not set" }), chosen, false, false)).toBe("board");
  });

  it("keeps settings open over everything", () => {
    expect(pageMode(config(), chosen, false, true)).toBe("settings");
  });
});

describe("the key screen", () => {
  it("shows the field and the build's hint on where to get a key; the hint's link opens outside bb", () => {
    const { rpc } = fakeRpc({ ok: true, code: null });
    const slot = renderSlot({ component: KeyStep }, { t: messages.ru, rpc, config: config({ keyHelp: help }), steps: false, onSaved: () => undefined });
    expect(slot.getByText("Вход по ключу API")).toBeTruthy();
    expect(slot.getByText("Где взять ключ")).toBeTruthy();
    expect(slot.container.querySelector(".tb-steps")).toBeNull();
    const button = slot.getByRole("button", { name: "Сохранить и проверить" }) as HTMLButtonElement;
    // Nothing typed yet: the button waits.
    expect(button.disabled).toBe(true);
    fireEvent.click(slot.getByText("https://tracker.example.com/settings/keys"));
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("https://tracker.example.com/settings/keys");
  });

  it("saves the key, marks it present and hands over to the page", async () => {
    const { rpc, call } = fakeRpc({ ok: true, code: null });
    const onSaved = vi.fn();
    hasKeyStore.set(false);
    const slot = renderSlot({ component: KeyStep }, { t: messages.en, rpc, config: config(), steps: true, onSaved });
    expect(slot.container.querySelector(".tb-steps")).not.toBeNull();
    expect(slot.queryByText("Where to get the key")).toBeNull();
    fireEvent.change(slot.getByLabelText("API key"), { target: { value: "  key-123  " } });
    fireEvent.click(slot.getByRole("button", { name: "Save and check" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith("saveKey", { key: "key-123" });
    expect(hasKeyStore.get()).toBe(true);
  });

  it("says why a key did not work and stays on the screen", async () => {
    const { rpc } = fakeRpc({ ok: false, code: "unauthorized" });
    const onSaved = vi.fn();
    hasKeyStore.set(false);
    const slot = renderSlot({ component: KeyStep }, { t: messages.en, rpc, config: config(), steps: false, onSaved });
    fireEvent.change(slot.getByLabelText("API key"), { target: { value: "wrong" } });
    fireEvent.click(slot.getByRole("button", { name: "Save and check" }));
    await waitFor(() => expect(slot.container.querySelector(".tb-error")).not.toBeNull());
    expect(onSaved).not.toHaveBeenCalled();
    expect(hasKeyStore.get()).toBe(false);
  });

  it("splits a hint into text and links, the full stop after a link staying text", () => {
    expect(helpParts(help)).toEqual([
      { text: "Profile → API keys: " },
      { text: "https://tracker.example.com/settings/keys", url: "https://tracker.example.com/settings/keys" },
      { text: "." },
      { text: " Ask the team lead if the page is empty." },
    ]);
    expect(helpParts("Ask the team lead.")).toEqual([{ text: "Ask the team lead." }]);
    expect(helpParts("javascript:alert(1)")).toEqual([{ text: "javascript:alert(1)" }]);
  });
});

describe("the settings button", () => {
  it("is the lucide gear, not the rays that read as a sun", () => {
    const html = renderToStaticMarkup(createElement(Icons.gear));
    expect(html).toContain("M9.671 4.136");
    expect(html).not.toContain("M12 2v3");
  });
});
