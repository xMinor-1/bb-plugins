// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportPage } from "../components/ReportPage";
import type { rpcContract } from "../server";

type Config = { label: string; formUrl: string; canSend: boolean; canAttach: boolean; combine: boolean; problem: string | null };
type SendInput = { subject: string; description: string; client: string; images: Array<{ name: string; type: string; base64: string }> };

const FORM = "https://forms.example.test/bugs";
const READY: Config = { label: "Bug report", formUrl: FORM, canSend: true, canAttach: true, combine: false, problem: null };
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

function render(config: Config, send: (input: SendInput) => unknown = () => ({ ok: true, key: "BUGS-1", url: "https://t.test/BUGS-1" })) {
  const sent: SendInput[] = [];
  const slot = renderSlot<object, typeof rpcContract>({ component: ReportPage }, {}, {
    rpc: {
      config: () => config,
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

describe("plugin app", () => {
  it("adds a sidebar page with the bug icon and no floating button", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map((panel) => [panel.id, panel.path, panel.title, panel.icon])).toEqual([["report", "report", "Bug report", "bug-report-button.bug"]]);
    expect(app.contentScripts ?? []).toHaveLength(0);
    expect(app.appOverlays).toHaveLength(0);
  });
});
