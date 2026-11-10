// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportPage } from "../components/ReportPage";
import { openInOwnBrowser, REOPEN_AFTER_MS, resetAutoOpen, shouldAutoOpen } from "../src/open";
import type { rpcContract } from "../server";

type KeyStatus = { hasKey: boolean; source: "own" | "shared" | null; keyStore: "keychain" | "credential-manager" | "file" | null };
type Config = {
  label: string; formUrl: string; canSend: boolean; canAttach: boolean; combine: boolean; picturesStay: boolean; problem: string | null;
  mode: "form" | "rest" | "open"; key: KeyStatus | null; keyHelp: string; keyProblem: string | null;
};
type SendInput = { subject: string; description: string; client: string; images: Array<{ name: string; type: string; base64: string }> };

const FORM = "https://forms.example.test/bugs";
const READY: Config = { label: "Bug report", formUrl: FORM, canSend: true, canAttach: true, combine: false, picturesStay: false, problem: null, mode: "form", key: null, keyHelp: "", keyProblem: null };
const picture = (name: string, bytes = [1, 2, 3], type = "image/png") => new File([new Uint8Array(bytes)], name, { type });

/** jsdom has no DataTransfer: the parts the page reads. */
function transfer(files: File[], types = ["Files"]) {
  return { types, files, items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })), dropEffect: "none" };
}

beforeEach(() => {
  let n = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:test/${++n}`, revokeObjectURL: () => {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function render(
  config: Config,
  send: (input: SendInput) => unknown = () => ({ ok: true, key: "BUGS-1", url: "https://t.test/BUGS-1", warning: null }),
  key: { save?: (input: { key: string }) => KeyStatus; forget?: () => KeyStatus } = {},
) {
  const sent: SendInput[] = [];
  const slot = renderSlot<object, typeof rpcContract>({ component: ReportPage }, {}, {
    rpc: {
      config: () => config,
      key_save: (input) => (key.save ? key.save(input) : { hasKey: true, source: "own", keyStore: "keychain" }),
      key_forget: () => (key.forget ? key.forget() : { hasKey: false, source: null, keyStore: null }),
      send: async (input) => {
        sent.push(input as SendInput);
        return send(input as SendInput) as never;
      },
    },
  });
  return { slot, sent };
}

const subject = () => screen.getByPlaceholderText("What went wrong, in a few words") as HTMLInputElement;
const description = () => screen.getByPlaceholderText(/What you did/) as HTMLTextAreaElement;
const thumbs = () => screen.queryAllByRole("listitem").map((item) => item.querySelector("img")?.getAttribute("alt"));

describe("report page", () => {
  it("attaches dropped, pasted and chosen pictures, with previews, and removes one", async () => {
    render(READY);
    await screen.findByText(/Drop pictures here/);
    const page = screen.getByTestId("brb-page");

    fireEvent.dragEnter(page, { dataTransfer: transfer([]) });
    expect(screen.getByText("Drop to attach")).toBeTruthy();
    fireEvent.drop(page, { dataTransfer: transfer([picture("drop.png")]) });
    expect(screen.queryByText("Drop to attach")).toBeNull();

    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = transfer([picture("image.png")], ["Files"]);
    act(() => void document.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(true);

    fireEvent.change(screen.getByTestId("brb-picker"), { target: { files: [picture("chosen.jpg", [9], "image/jpeg")] } });
    await waitFor(() => expect(thumbs()).toEqual(["drop.png", "screenshot.png", "chosen.jpg"]));
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual(["blob:test/1", "blob:test/2", "blob:test/3"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot.png" }));
    expect(thumbs()).toEqual(["drop.png", "chosen.jpg"]);
  });

  it("leaves a text paste to the field", async () => {
    render(READY);
    await screen.findByText(/Drop pictures here/);
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { types: ["text/plain"], files: [], items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] };
    act(() => void subject().dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(false);
  });

  it("explains a picture it refuses, in words", async () => {
    render(READY);
    await screen.findByText(/Drop pictures here/);
    fireEvent.drop(screen.getByTestId("brb-page"), { dataTransfer: transfer([picture("notes.pdf", [1], "application/pdf")]) });
    expect(screen.getByRole("alert").textContent).toBe("notes.pdf is not a PNG, JPEG, GIF or WebP picture.");
    expect(thumbs()).toEqual([]);
  });

  it("sends subject, description and pictures, shows the record and clears the form", async () => {
    const { sent } = render(READY);
    await screen.findByText(/Drop pictures here/);
    fireEvent.change(subject(), { target: { value: "  Save fails " } });
    fireEvent.change(description(), { target: { value: "Steps" } });
    fireEvent.drop(screen.getByTestId("brb-page"), { dataTransfer: transfer([picture("a.png", [1, 2, 3]), picture("b.png", [4])]) });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const link = (await screen.findByRole("link", { name: "BUGS-1" })) as HTMLAnchorElement;
    expect(link.href).toBe("https://t.test/BUGS-1");
    expect(link.target).toBe("_blank");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subject: "Save fails", description: "Steps", images: [{ name: "a.png", type: "image/png", base64: "AQID" }, { name: "b.png", type: "image/png", base64: "BA==" }] });
    expect(sent[0]!.client).toMatch(/window \d+x\d+$/);
    expect(subject().value).toBe("");
    expect(description().value).toBe("");
    expect(thumbs()).toEqual([]);
  });

  it("keeps everything typed and attached when sending fails", async () => {
    render(READY, () => ({ ok: false, error: "The form's server failed (HTTP 502)." }));
    await screen.findByText(/Drop pictures here/);
    fireEvent.change(subject(), { target: { value: "Save fails" } });
    fireEvent.change(description(), { target: { value: "Steps" } });
    fireEvent.drop(screen.getByTestId("brb-page"), { dataTransfer: transfer([picture("a.png")]) });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The form's server failed (HTTP 502).");
    expect(subject().value).toBe("Save fails");
    expect(description().value).toBe("Steps");
    expect(thumbs()).toEqual(["a.png"]);
  });

  it("asks for a subject before sending", async () => {
    const { sent } = render(READY);
    await screen.findByText(/Drop pictures here/);
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Write a subject/);
    expect(sent).toHaveLength(0);
  });

  it("links to the form when sending is not set up, as the 0.1 button did", async () => {
    render({ ...READY, canSend: false, canAttach: false, label: "Сообщить о баге" });
    const link = (await screen.findByRole("link", { name: "Open the form" })) as HTMLAnchorElement;
    expect(link.href).toBe(FORM);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(screen.getByRole("heading").textContent).toBe("Сообщить о баге");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("report page, REST mode", () => {
  const REST: Config = { ...READY, mode: "rest", key: { hasKey: false, source: null, keyStore: null }, keyHelp: "Profile → API keys." };

  it("asks for the key first, saves it with Enter and then sends", async () => {
    const saved: string[] = [];
    const { sent } = render(REST, undefined, { save: ({ key }) => (saved.push(key), { hasKey: true, source: "own", keyStore: "keychain" }) });
    const field = (await screen.findByPlaceholderText("Paste the key")) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(screen.getByTestId("brb-key").textContent).toMatch(/Profile → API keys\. The key stays in this computer's key store/);
    fireEvent.change(subject(), { target: { value: "Bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Save your API key first.");
    expect(sent).toHaveLength(0);

    fireEvent.change(field, { target: { value: "  xk_secret " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await screen.findByText(/Sending with your API key, saved in Keychain on this computer/);
    expect(saved).toEqual(["xk_secret"]);
    expect(sent).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("link", { name: "BUGS-1" });
    expect(sent).toHaveLength(1);
  });

  it("uses the tracker board's key, and does not offer to forget it", async () => {
    render({ ...REST, key: { hasKey: true, source: "shared", keyStore: "credential-manager" } });
    await screen.findByText("Sending with the API key you saved for the tracker board (Credential Manager).");
    expect(screen.queryByRole("button", { name: "Forget key" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change key" }));
    expect(screen.getByPlaceholderText("Paste the key")).toBeTruthy();
  });

  it("forgets its own key", async () => {
    render({ ...REST, key: { hasKey: true, source: "own", keyStore: "file" } });
    fireEvent.click(await screen.findByRole("button", { name: "Forget key" }));
    expect(await screen.findByPlaceholderText("Paste the key")).toBeTruthy();
  });

  it("says when pictures did not make it, and still shows the record", async () => {
    render({ ...REST, key: { hasKey: true, source: "own", keyStore: "keychain" } }, () => ({
      ok: true, key: "BUGS-2", url: null, warning: "The report is sent, but the pictures are not attached.",
    }));
    fireEvent.change(await screen.findByPlaceholderText("What went wrong, in a few words"), { target: { value: "Bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByText("BUGS-2")).tagName).toBe("STRONG");
    expect(screen.getByRole("alert").textContent).toBe("The report is sent, but the pictures are not attached.");
  });

  it("form without pictures: sends the text only, keeps the pictures and links to the form to attach them", async () => {
    const { sent } = render({ ...REST, picturesStay: true, key: { hasKey: true, source: "own", keyStore: "keychain" } }, () => ({ ok: true, key: null, url: null, warning: null }));
    await screen.findByText(/after sending you get a link to attach them in the tracker/);
    fireEvent.change(subject(), { target: { value: "Bug" } });
    fireEvent.drop(screen.getByTestId("brb-page"), { dataTransfer: transfer([picture("a.png"), picture("b.png", [4])]) });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const left = await screen.findByTestId("brb-pictures-left");
    expect(left.textContent).toBe("The form did not take the 2 pictures: they are still here. Attach them in the tracker: open the form.");
    expect((left.querySelector("a") as HTMLAnchorElement).href).toBe(FORM);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.images).toEqual([]);
    expect(subject().value).toBe("");
    expect(thumbs()).toEqual(["a.png", "b.png"]);
  });

  it("form without pictures: no note when there was nothing to attach", async () => {
    render({ ...REST, picturesStay: true, key: { hasKey: true, source: "own", keyStore: "keychain" } }, () => ({ ok: true, key: null, url: null, warning: null }));
    fireEvent.change(await screen.findByPlaceholderText("What went wrong, in a few words"), { target: { value: "Bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/Sent/);
    expect(screen.queryByTestId("brb-pictures-left")).toBeNull();
  });

  it("shows why the key could not be checked", async () => {
    render({ ...REST, key: null, keyProblem: "Could not check the API key on this computer: offline" });
    expect((await screen.findByRole("alert")).textContent).toBe("Could not check the API key on this computer: offline");
  });
});

describe("plugin app", () => {
  it("adds a sidebar page with the bug icon and no floating button", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map((panel) => [panel.id, panel.path, panel.title, panel.icon])).toEqual([["report", "report", "Bug report", "bug-report-button.bug"]]);
    expect(app.contentScripts ?? []).toHaveLength(0);
    expect(app.appOverlays).toHaveLength(0);
  });
});

describe("open mode: the bug only opens the form", () => {
  const OPEN: Config = { ...READY, canSend: false, canAttach: false, mode: "open" };
  beforeEach(() => resetAutoOpen());
  afterEach(() => {
    delete (window as { bbDesktop?: unknown }).bbDesktop;
  });

  it("opens the form in the person's browser through the desktop app, once per mount, and shows only the button", async () => {
    const opened: string[] = [];
    (window as { bbDesktop?: unknown }).bbDesktop = { openExternalUrl: (url: string) => void opened.push(url) };
    const { slot } = render(OPEN);
    const button = await screen.findByRole("button", { name: "Open the form" });
    expect(opened).toEqual([FORM]);
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/Drop pictures/)).toBeNull();
    expect(screen.queryByTestId("brb-key")).toBeNull();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);

    fireEvent.click(button);
    expect(opened).toEqual([FORM, FORM]);
  });

  it("in the web app opens through bb's own openUrl", async () => {
    const { slot } = render(OPEN);
    await screen.findByRole("button", { name: "Open the form" });
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: FORM }]));
  });

  it("a second mount right after the first opens nothing more", async () => {
    const opened: string[] = [];
    (window as { bbDesktop?: unknown }).bbDesktop = { openExternalUrl: (url: string) => void opened.push(url) };
    render(OPEN);
    await screen.findByRole("button", { name: "Open the form" });
    cleanup();
    render(OPEN);
    await screen.findByRole("button", { name: "Open the form" });
    expect(opened).toEqual([FORM]);
  });

  it("without a form address says so and opens nothing", async () => {
    const opened: string[] = [];
    (window as { bbDesktop?: unknown }).bbDesktop = { openExternalUrl: (url: string) => void opened.push(url) };
    render({ ...OPEN, formUrl: "", problem: "There is no form yet: the plugin settings have no form address." });
    expect((await screen.findByRole("alert")).textContent).toMatch(/no form address/);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(opened).toEqual([]);
  });
});

describe("opening in the person's browser", () => {
  it("refuses anything but http(s) and falls back to openUrl when the desktop bridge throws", () => {
    const calls: string[] = [];
    const openUrl = (url: string) => (calls.push(url), true);
    expect(openInOwnBrowser("javascript:alert(1)", openUrl, { bbDesktop: { openExternalUrl: () => calls.push("desktop") } })).toBe(false);
    expect(openInOwnBrowser(FORM, openUrl, { bbDesktop: { openExternalUrl: () => { throw new Error("gone"); } } })).toBe(true);
    expect(calls).toEqual([FORM]);
  });

  it("opens again after the guard window", () => {
    resetAutoOpen();
    expect(shouldAutoOpen(1000)).toBe(true);
    expect(shouldAutoOpen(1000 + REOPEN_AFTER_MS - 1)).toBe(false);
    expect(shouldAutoOpen(1000 + REOPEN_AFTER_MS)).toBe(true);
  });
});
