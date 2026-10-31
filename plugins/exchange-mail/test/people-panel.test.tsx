// @vitest-environment jsdom
//
// The address book in the panel: the card in a thread where the person picks
// who the agent meant, and suggestions in the To field.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { Person } from "../contract";
import type { rpcContract } from "../server";

const captured = await loadPluginApp(() => import("../app"));
const { RecipientsInput } = await import("../src/app/RecipientsInput");
const { useRpc } = await import("@get-bb/plugin-sdk/app");

afterEach(cleanup);

const person = (name: string, email: string, title: string, kind: Person["kind"] = "person"): Person => ({ name, email, title, department: "Platform", company: null, office: null, kind });
const DENISES = [person("Denis Orlov", "denis.orlov@example.test", "Engineer"), person("Denis Petrov", "denis.petrov@example.test", "Accountant"), person("Design team", "design@example.test", "", "group")];

function renderChoice(payload: unknown) {
  const submitted: unknown[] = [];
  const registration = captured.pendingInteractions.find((r) => r.id === "mail-person-choice")!;
  renderSlot(registration, {
    interaction: { id: "pi_1", threadId: "th_1", title: "Choose a person", payload: payload as never, createdAt: 1, expiresAt: null },
    submit: async (value: unknown) => void submitted.push(value),
    cancel: async () => undefined,
  });
  return submitted;
}

describe("choosing a person in the thread", () => {
  it("shows everyone found with job title and department, and sends back the one chosen", async () => {
    const submitted = renderChoice({ query: "Den", people: DENISES });
    expect(screen.getByText("Several people match “Den”. Who do you mean?")).toBeTruthy();
    expect(screen.getByText("Engineer, Platform")).toBeTruthy();
    expect(screen.getByText("group")).toBeTruthy();
    fireEvent.click(screen.getByText("Denis Petrov"));
    await waitFor(() => expect(submitted).toEqual([{ email: "denis.petrov@example.test", lang: "en" }]));
    expect((screen.getByText("Denis Orlov").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("can say none of them", async () => {
    const submitted = renderChoice({ query: "Den", people: DENISES });
    fireEvent.click(screen.getByRole("button", { name: "None of them" }));
    await waitFor(() => expect(submitted).toEqual([{ email: null, lang: "en" }]));
  });

  it("shows nothing it cannot read", () => {
    renderChoice({ query: 1, people: "x" });
    expect(screen.getByText("This choice cannot be shown.")).toBeTruthy();
  });
});

describe("suggestions in the To field", () => {
  function renderField(initial = "") {
    const asked: string[] = [];
    const handlers = {
      findPeople: ({ query }: { query: string }) => {
        asked.push(query);
        return { people: DENISES.filter((p) => p.name.toLowerCase().startsWith(query.toLowerCase())), more: false };
      },
    } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
    let value = initial;
    function Harness() {
      const [text, setText] = useState(initial);
      return (
        <RecipientsInput
          rpc={useRpc<typeof rpcContract>()}
          hostId="host_1"
          value={text}
          onChange={(next) => {
            value = next;
            setText(next);
          }}
          ariaLabel="To"
        />
      );
    }
    renderSlot({ component: Harness }, {}, { rpc: handlers });
    return { asked, value: () => value };
  }

  it("suggests people for the name being typed and puts the chosen one in its place", async () => {
    const field = renderField();
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bob@example.test, Denis" } });
    await screen.findByRole("option", { name: /Denis Petrov/ });
    expect(field.asked).toEqual(["Denis"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(field.value()).toBe("bob@example.test, Denis Petrov <denis.petrov@example.test>, ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picks with a click, and Escape closes the list", async () => {
    const field = renderField();
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Den" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.change(input, { target: { value: "Des" } });
    fireEvent.click(await screen.findByRole("option", { name: /Design team/ }));
    expect(field.value()).toBe("Design team <design@example.test>, ");
  });

  it("asks nothing for one letter or for a recipient already written out", async () => {
    const field = renderField();
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "D" } });
    fireEvent.change(input, { target: { value: "Denis Orlov <denis.orlov@example.test>" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(field.asked).toEqual([]);
  });
});
