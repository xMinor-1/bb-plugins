// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScenarioPreview } from "../src/app/preview";

beforeEach(() => localStorage.setItem("xminor-plugins.lang", "en"));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SCENARIO = {
  id: "my-1a2b3c4d",
  label: "Invoice check",
  group: "mine-own",
  description: "Check an invoice against the contract",
  fields: [
    { id: "invoice", label: "Invoice", type: "attachment", required: true },
    { id: "party", label: "Counterparty", type: "text", required: true, placeholder: "Name or tax id" },
    { id: "note", label: "Note", type: "textarea" },
  ],
  prompt: "Check the attached invoice.\nCounterparty: {{party}}",
};

function render(payload: unknown) {
  const answers: unknown[] = [];
  let cancelled = 0;
  renderSlot({ component: ScenarioPreview }, {
    interaction: { id: "i1", threadId: "t1", title: "Scenario", payload: payload as never, createdAt: 0, expiresAt: null },
    submit: async (value: unknown) => {
      answers.push(value);
    },
    cancel: async () => {
      cancelled++;
    },
  });
  return { answers, cancelled: () => cancelled };
}

describe("ScenarioPreview", () => {
  it("shows the tag, its form with required marks, and the prompt; Save answers yes", async () => {
    const { answers } = render({ scenario: SCENARIO, replaces: null });
    expect(screen.getByRole("heading", { name: "Save this scenario?" })).toBeTruthy();
    expect(screen.getByText("Invoice check")).toBeTruthy();
    expect(screen.getAllByTitle("Required")).toHaveLength(2);
    expect((screen.getByLabelText(/Counterparty/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Check the attached invoice\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(answers).toEqual([{ save: true }]));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the scenario it replaces and answers no on Don't save", async () => {
    const { answers } = render({ scenario: SCENARIO, replaces: "Old invoice check" });
    expect(screen.getByRole("heading", { name: "Replace your scenario “Old invoice check”?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Don't save" }));
    await waitFor(() => expect(answers).toEqual([{ save: false }]));
  });

  it("offers no Save for a payload that fails the checks", async () => {
    const { answers, cancelled } = render({ scenario: { ...SCENARIO, prompt: "{{missing}}" }, replaces: null });
    expect(screen.getByText(/cannot be saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(cancelled()).toBe(1));
    expect(answers).toEqual([]);
  });
});
