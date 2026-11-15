// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScenarioBar } from "../app";
import type { OwnPins } from "../src/catalog";
import { CATALOG_JSON } from "./fixtures";

beforeEach(() => localStorage.setItem("xminor-plugins.lang", "en"));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function render(options: { catalog?: string; own?: OwnPins | null; text?: string; attachments?: number } = {}) {
  const saved: Array<OwnPins | null> = [];
  let own = options.own ?? null;
  const slot = renderSlot({ component: ScenarioBar }, {}, {
    settings: { scenarios: options.catalog ?? CATALOG_JSON },
    composer: { text: options.text ?? "", attachmentCount: options.attachments ?? 0, scope: { kind: "thread", threadId: "t1" } },
    rpc: {
      pins_get: () => ({ own }),
      pins_set: (input: unknown) => {
        own = (input as { own: OwnPins | null }).own;
        saved.push(own);
        return { own };
      },
    },
  });
  return { slot, saved };
}

describe("ScenarioBar", () => {
  it("registers a bare banner for thread and new-thread composers", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.composerCustomizations).toHaveLength(1);
    expect(app.composerCustomizations[0]!.scopes).toEqual(["thread", "new-thread"]);
    expect(app.composerCustomizations[0]!.banners?.[0]?.chrome).toBe("bare");
  });

  it("renders nothing without a catalog", () => {
    const { slot } = render({ catalog: "" });
    expect(slot.container.textContent).toBe("");
  });

  it("shows the pinned tags collapsed and every group expanded", async () => {
    render();
    expect(await screen.findByRole("button", { name: "Reports" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Contract check" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all scenarios" }));
    expect(screen.getByRole("heading", { name: "Contracts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Contract check" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Other" })).toBeTruthy();
  });

  it("will not insert until required questions are answered, then puts the prompt in the box", async () => {
    const { slot } = render();
    fireEvent.click(await screen.findByRole("button", { name: "Reports" }));
    const form = screen.getByRole("form", { name: "Reports" });
    fireEvent.click(screen.getByRole("button", { name: /Put into message/ }));
    expect(screen.getByRole("alert").textContent).toMatch(/required/);
    expect(slot.inspection.composer.text).toBe("");

    fireEvent.change(screen.getByLabelText(/Question/), { target: { value: "Which sheet shows trips?" } });
    fireEvent.click(screen.getByRole("button", { name: /Put into message/ }));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Read the reports guide first.\nQuestion: Which sheet shows trips?"));
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(form.isConnected).toBe(false);
  });

  it("keeps what the person already typed", async () => {
    const { slot } = render({ text: "Hello" });
    fireEvent.click(await screen.findByRole("button", { name: "Reports" }));
    fireEvent.change(screen.getByLabelText(/Question/), { target: { value: "Q" } });
    fireEvent.keyDown(screen.getByLabelText(/Question/), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(slot.inspection.composer.text).toContain("Read the reports guide first."));
    expect(slot.inspection.composer.text.startsWith("Hello")).toBe(true);
  });

  async function fillContract() {
    fireEvent.click(screen.getByRole("button", { name: "Show all scenarios" }));
    fireEvent.click(await screen.findByRole("button", { name: "Contract check" }));
    fireEvent.change(screen.getByLabelText(/Counterparty/), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /Put into message/ }));
  }

  it("needs a file on the message for a required attachment", async () => {
    const { slot } = render();
    await fillContract();
    expect(screen.getByText(/Attach the file to the message/)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(slot.inspection.composer.text).toBe("");
  });

  it("takes the attached file as the answer", async () => {
    const { slot } = render({ attachments: 1 });
    await fillContract();
    await waitFor(() => expect(slot.inspection.composer.text).toContain("Contract: see the attached file"));
  });

  it("closes the form on Escape without touching the box", async () => {
    const { slot } = render();
    fireEvent.click(await screen.findByRole("button", { name: "Reports" }));
    fireEvent.keyDown(screen.getByLabelText(/Question/), { key: "Escape" });
    expect(screen.queryByRole("form")).toBeNull();
    expect(slot.inspection.composer.text).toBe("");
  });

  it("pins a tag to the row and saves the pick", async () => {
    const { saved } = render();
    fireEvent.click(await screen.findByRole("button", { name: "Show all scenarios" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin “Contract check” to the row" }));
    expect(saved).toEqual([{ pins: ["report-guide", "contract-check"], known: ["report-guide"] }]);
    expect(screen.getByRole("button", { name: "Unpin “Contract check” from the row" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the default tags" }));
    expect(saved.at(-1)).toBeNull();
  });

  it("speaks Russian when the language is Russian", async () => {
    localStorage.setItem("xminor-plugins.lang", "ru");
    render();
    expect(await screen.findByRole("button", { name: "Показать все сценарии" })).toBeTruthy();
  });
});
