// @vitest-environment jsdom
//
// The draft card with its send dialog open. Whatever load reaches the card —
// including one that started before the dialog opened — must not change what
// the dialog shows. A different version closes the dialog and comes with a
// note; the same version leaves it as it is.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { Draft } from "../contract";
import type { rpcContract } from "../server";

const app = await loadPluginApp(() => import("../app"));
const { DraftCard } = await import("../src/app/DraftCard");
const { useRpc } = await import("@get-bb/plugin-sdk/app");
const { messages } = await import("../src/messages");
const { setLang } = await import("../lib/i18n");
const directive = app.messageDirectives.find((entry) => entry.id === "mail-draft")!;
const t = messages.en;

const ID = "d_0123456789ab";
const draft = (revision: string, text: string): Draft => ({
  id: ID,
  kind: "new",
  source: "agent",
  threadId: "thr_1",
  createdAt: 1,
  subject: "Plan for Friday",
  to: [{ name: null, email: "bob@example.test" }],
  cc: [],
  bcc: [],
  attachments: [],
  bodyFormat: "text",
  body: text,
  text,
  replyTo: null,
  revision,
});

/** A `draft` call that answers only when the test says so. */
function heldLoads() {
  const waiting: Array<(draft: Draft | null) => void> = [];
  let calls = 0;
  const handlers = {
    draft: () => {
      calls += 1;
      return new Promise<{ draft: Draft | null; hostId: string }>((resolve) => waiting.push((next) => resolve({ draft: next, hostId: "host_1" })));
    },
  } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
  return {
    handlers,
    get calls() {
      return calls;
    },
    /** Answer the oldest load still waiting. */
    async answer(next: Draft | null) {
      const resolve = waiting.shift();
      if (!resolve) throw new Error("no load is waiting");
      await act(async () => resolve(next));
    },
  };
}

const props = { attributes: { id: ID }, source: `::mail-draft{id="${ID}"}`, message: { id: "m_1", threadId: "thr_1", turnId: null, projectId: null }, openWorkspaceFile: null } satisfies PluginMessageDirectiveProps;

const dialog = () => screen.queryByRole("dialog");

async function openWithLoadInFlight(loads: ReturnType<typeof heldLoads>) {
  const slot = renderSlot(directive, props, { rpc: loads.handlers });
  await loads.answer(draft("CK1", "Version one"));
  await screen.findByText("Version one");
  // Someone touched the draft: the card starts a load, and before it answers the person opens the dialog.
  await slot.behavior.emitRealtime("drafts-changed", { id: ID });
  await waitFor(() => expect(loads.calls).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: t.sendButton }));
  await waitFor(() => expect(dialog()).not.toBeNull());
  return slot;
}

afterEach(() => {
  cleanup();
  setLang(null);
});

describe("the draft card while its send dialog is open", () => {
  it("closes the dialog and shows the new version when a load started before the dialog brings one", async () => {
    const loads = heldLoads();
    await openWithLoadInFlight(loads);
    await loads.answer(draft("CK2", "Version two"));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByText(t.changedWhileConfirming)).toBeTruthy();
    expect(screen.getByText("Version two")).toBeTruthy();
    expect(screen.queryByText("Version one")).toBeNull();
  });

  it("leaves the dialog and its content alone when that load brings the same version", async () => {
    const loads = heldLoads();
    await openWithLoadInFlight(loads);
    await loads.answer(draft("CK1", "Version one"));
    expect(dialog()).not.toBeNull();
    expect(screen.queryByText(t.changedWhileConfirming)).toBeNull();
    expect(screen.getAllByText("Version one").length).toBeGreaterThan(0);
  });

  it("closes the dialog with a note when that load finds the draft gone", async () => {
    const loads = heldLoads();
    await openWithLoadInFlight(loads);
    await loads.answer(null);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByText(t.draftGone(ID))).toBeTruthy();
  });

  it("treats a newer version from the list around it the same way", async () => {
    const loads = heldLoads();
    let setInitial: (next: Draft) => void = () => {};
    function Waiting() {
      const rpc = useRpc<typeof rpcContract>();
      const [initial, set] = useState(draft("CK1", "Version one"));
      setInitial = set;
      // The list keys cards by draft id, so a new revision reaches the same card.
      return <DraftCard key={initial.id} rpc={rpc} target={{ hostId: "host_1" }} id={ID} initial={initial} />;
    }
    renderSlot({ component: Waiting }, {}, { rpc: loads.handlers });
    fireEvent.click(screen.getByRole("button", { name: t.sendButton }));
    await waitFor(() => expect(dialog()).not.toBeNull());
    await act(async () => setInitial(draft("CK1", "Version one")));
    expect(dialog()).not.toBeNull();
    await act(async () => setInitial(draft("CK2", "Version two")));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByText(t.changedWhileConfirming)).toBeTruthy();
    expect(screen.getByText("Version two")).toBeTruthy();
  });
});

describe("a failure from the machine with the mailbox", () => {
  it("is shown in the panel's language", async () => {
    setLang("ru");
    const handlers = {
      draft: () => Promise.reject(new Error("[mail:unreachable:Could%20not%20resolve%20host] Exchange is not reachable from this machine. Check the corporate network or VPN.")),
    } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
    renderSlot(directive, props, { rpc: handlers });
    expect(await screen.findByText(`Черновик ${ID}: С этой машины Exchange недоступен. Проверьте корпоративную сеть или VPN. (curl: Could not resolve host)`)).toBeTruthy();
  });
});
