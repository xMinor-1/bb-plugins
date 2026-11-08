// @vitest-environment jsdom
//
// The Messenger page: ready-made requests that open an agent's chat, and what it says after signing in.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { Status } from "../contract";
import type { Overview, rpcContract } from "../server";
import { ASKS } from "../src/app/asks";
import { setLang } from "../lib/i18n";

const captured = await loadPluginApp(() => import("../app"));
const page = captured.navPanels.find((panel) => panel.id === "messenger")!;

afterEach(cleanup);
beforeEach(() => setLang("en"));

const overview: Overview = {
  machines: [{ id: "host_mac", name: "Mac", connected: true }],
  lastUsed: "host_mac",
  url: "https://express.example.com/",
  policy: { rules: [{ provider: "acp-opencode", model: "corp/*" }], error: null },
  digestAgent: { text: "acp-opencode corp/large", problem: null },
};

function handlers(status: Status, signIn?: { ok: boolean; message: string; chats: number; people: number }) {
  return {
    overview: () => overview,
    status: () => status,
    rules: () => ({ rules: [] }),
    signIn: () => signIn ?? { ok: true, message: "Signed in.", chats: 0, people: 0 },
  } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
}

const signedIn: Status = { platform: "darwin", browser: "/Applications/Chrome", open: false, signedIn: true, directory: { at: 1, chats: 5, people: 3 }, lastError: null };

describe("ready-made requests", () => {
  it("opens a new thread on the chosen machine with the request in the message field", async () => {
    const view = renderSlot(page, { subPath: "" }, { rpc: handlers(signedIn) });
    await screen.findByText("Ask an agent");
    expect(ASKS.en.length).toBeGreaterThan(0);
    for (const ask of ASKS.en) expect(screen.getByText(ask.title)).toBeTruthy();
    expect(screen.queryByText(/Sign in first/)).toBeNull();
    fireEvent.click(screen.getAllByText("Open in chat")[0]!);
    expect(view.inspection.navigateCalls).toContainEqual(
      { method: "toCompose", options: { initialPrompt: ASKS.en[0]!.prompt, focusPrompt: true, hostId: "host_mac" } },
    );
  });

  it("asks to sign in first while the machine is not signed in", async () => {
    renderSlot(page, { subPath: "" }, { rpc: handlers({ ...signedIn, signedIn: null, directory: null }) });
    expect(await screen.findByText("Sign in first: until then the agent cannot see your chats.")).toBeTruthy();
  });

  it("has the same requests in both languages, each about the messenger", () => {
    expect(ASKS.ru.length).toBe(ASKS.en.length);
    for (const ask of ASKS.en) expect(ask.prompt).toMatch(/messenger/i);
    for (const ask of ASKS.ru) expect(ask.prompt).toMatch(/мессенджер/i);
    ASKS.en.forEach((ask, i) => expect(ASKS.ru[i]!.prompt.split("…").length).toBe(ask.prompt.split("…").length));
  });
});

describe("signing in", () => {
  it("says how many chats and people the directory holds right after signing in", async () => {
    renderSlot(page, { subPath: "" }, { rpc: handlers({ ...signedIn, signedIn: null, directory: null }, { ok: true, message: "Signed in. The directory has 5 chats and 3 people.", chats: 5, people: 3 }) });
    fireEvent.click(await screen.findByText("Sign in"));
    expect(await screen.findByText("Signed in. The directory has 5 chats and 3 people: agents can find them now.")).toBeTruthy();
  });

  it("says why the directory is missing when signing in worked but building it did not", async () => {
    renderSlot(page, { subPath: "" }, { rpc: handlers({ ...signedIn, signedIn: null, directory: null }, { ok: true, message: "[express:unreachable] The messenger does not open.", chats: 0, people: 0 }) });
    fireEvent.click(await screen.findByText("Sign in"));
    await waitFor(() => expect(screen.getByText(/^Signed in, but the directory was not built: The messenger does not open from this machine/)).toBeTruthy());
    expect(screen.getByText(/Press “Update directory”/)).toBeTruthy();
  });
});
