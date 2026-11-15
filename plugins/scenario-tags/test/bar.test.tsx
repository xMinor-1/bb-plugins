// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

function render(
  options: {
    catalog?: string;
    own?: OwnPins | null;
    text?: string;
    attachments?: number;
    mine?: unknown[];
    settings?: Record<string, string>;
    scope?: { kind: "thread"; threadId: string } | { kind: "new-thread"; projectId: string };
  } = {},
) {
  const saved: Array<OwnPins | null> = [];
  const deleted: string[] = [];
  let own = options.own ?? null;
  let mine = options.mine ?? [];
  const slot = renderSlot({ component: ScenarioBar }, {}, {
    settings: { scenarios: options.catalog ?? CATALOG_JSON, ...options.settings },
    composer: { text: options.text ?? "", attachmentCount: options.attachments ?? 0, scope: options.scope ?? { kind: "thread", threadId: "t1" } },
    rpc: {
      pins_get: () => ({ own }),
      pins_set: (input: unknown) => {
        own = (input as { own: OwnPins | null }).own;
        saved.push(own);
        return { own };
      },
      own_list: () => ({ scenarios: mine }),
      own_delete: (input: unknown) => {
        const { id } = input as { id: string };
        deleted.push(id);
        mine = mine.filter((s) => (s as { id: string }).id !== id);
        return { removed: true };
      },
    },
  });
  return { slot, saved, deleted };
}

describe("ScenarioBar", () => {
  it("registers a bare banner for thread and new-thread composers", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.composerCustomizations).toHaveLength(1);
    expect(app.composerCustomizations[0]!.scopes).toEqual(["thread", "new-thread"]);
    expect(app.composerCustomizations[0]!.banners?.[0]?.chrome).toBe("bare");
  });

  it("without a catalog still offers to make a scenario", async () => {
    const { slot } = render({ catalog: "" });
    expect(await screen.findByText("Make a tag for a task you repeat")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all scenarios" }));
    fireEvent.click(screen.getByRole("button", { name: /New scenario/ }));
    expect(slot.inspection.composer.text).toMatch(/scenario_save/);
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

const MINE = {
  id: "my-1a2b3c4d",
  label: "Invoice check",
  group: "mine-own",
  fields: [{ id: "party", label: "Counterparty", type: "text", required: true }],
  prompt: "Check the invoice.\nCounterparty: {{party}}",
};

describe("own scenarios", () => {
  it("puts the builder prompt from the settings into the box", async () => {
    const { slot } = render({ settings: { builderPrompt: "Build me a scenario, ask first." } });
    fireEvent.click(await screen.findByRole("button", { name: "Show all scenarios" }));
    fireEvent.click(screen.getByRole("button", { name: /New scenario/ }));
    expect(slot.inspection.composer.text).toBe("Build me a scenario, ask first.");
    expect(slot.inspection.composer.submits).toEqual([]);
  });

  it("offers to save the conversation only in a thread", async () => {
    const { slot } = render({ text: "draft" });
    fireEvent.click(await screen.findByRole("button", { name: "Show all scenarios" }));
    fireEvent.click(screen.getByRole("button", { name: "Save this conversation as a scenario" }));
    expect(slot.inspection.composer.text.startsWith("draft")).toBe(true);
    expect(slot.inspection.composer.text).toMatch(/Turn this conversation into a scenario/);
    cleanup();
    render({ scope: { kind: "new-thread", projectId: "p1" } });
    fireEvent.click(await screen.findByRole("button", { name: "Show all scenarios" }));
    expect(screen.queryByRole("button", { name: "Save this conversation as a scenario" })).toBeNull();
  });

  it("shows own scenarios first under Mine and runs their form", async () => {
    const { slot } = render({ mine: [MINE] });
    fireEvent.click(await screen.findByRole("button", { name: "Show all scenarios" }));
    await screen.findByRole("heading", { name: "Mine" });
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Mine", "Contracts", "Reports", "Other"]);
    fireEvent.click(screen.getByRole("button", { name: "Invoice check" }));
    fireEvent.click(screen.getByRole("button", { name: /Put into message/ }));
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Counterparty/), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /Put into message/ }));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Check the invoice.\nCounterparty: Acme"));
  });

  it("changes an own scenario through the agent with its id and JSON", async () => {
    const { slot } = render({ mine: [MINE], settings: { editPrompt: "Change “{{label}}” ({{id}}):\n{{scenario}}" } });
    fireEvent.click(await screen.findByRole("button", { name: "Show all scenarios" }));
    fireEvent.click(await screen.findByRole("button", { name: "Change “Invoice check”" }));
    const text = slot.inspection.composer.text;
    expect(text.startsWith("Change “Invoice check” (my-1a2b3c4d):\n{")).toBe(true);
    expect(JSON.parse(text.slice(text.indexOf("{")))).toMatchObject({ id: "my-1a2b3c4d", prompt: MINE.prompt });
  });

  it("deletes an own scenario after a confirm", async () => {
    const { deleted } = render({ mine: [MINE] });
    fireEvent.click(await screen.findByRole("button", { name: "Show all scenarios" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete “Invoice check”" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(deleted).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete “Invoice check”" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(deleted).toEqual(["my-1a2b3c4d"]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Invoice check" })).toBeNull());
  });

  it("suggests an own scenario as a file, with the build's instructions and email", async () => {
    render({ mine: [MINE], settings: { suggestEmail: "keeper@example.test", suggestHint: "Send it to the keeper." } });
    fireEvent.click(await screen.findByRole("button", { name: "Show all scenarios" }));
    fireEvent.click(await screen.findByRole("button", { name: "Suggest “Invoice check” to everyone" }));
    const panel = screen.getByRole("region", { name: "Suggest “Invoice check” to everyone" });
    expect(panel.textContent).toMatch(/Send it to the keeper\./);
    expect(within(panel).getByRole("button", { name: /Download file/ })).toBeTruthy();
    const mail = within(panel).getByRole("link", { name: /Write an email/ }).getAttribute("href")!;
    expect(mail.startsWith("mailto:keeper%40example.test?subject=Scenario%3A%20Invoice%20check")).toBe(true);
    expect(decodeURIComponent(mail)).toMatch(/"id": "1a2b3c4d"/);
  });

  it("adds Save as scenario to the plus menu of thread composers", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const item = app.composerCustomizations[0]!.plusMenu![0]!;
    expect(item.id).toBe("save-as-scenario");
    expect(typeof item.disabled).toBe("function");
    expect(app.pendingInteractions.map((r) => r.id)).toEqual(["scenario-preview"]);
  });
});
