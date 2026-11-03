// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bugReportButton from "../server";
import { BUG_SVG, BUTTON_ID, DEFAULT_LABEL, readConfig, readFormUrl, showButton, watchButton } from "../src/button";

const FORM = "https://forms.example.test/report?team=7";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const button = () => document.getElementById(BUTTON_ID) as HTMLAnchorElement | null;

let undos: Array<() => void> = [];
const watch = (load: () => Promise<Record<string, unknown>>, recheckMs = 1_000_000) => {
  const undo = watchButton(document, load, recheckMs);
  undos.push(undo);
  return undo;
};

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const undo of undos) undo();
  undos = [];
  vi.useRealTimers();
});

describe("settings", () => {
  it("accepts http and https addresses", () => {
    expect(readFormUrl(FORM)).toBe(FORM);
    expect(readFormUrl(`  ${FORM}  `)).toBe(FORM);
    expect(readFormUrl("http://localhost:9000/form")).toBe("http://localhost:9000/form");
  });

  it("refuses anything that could run in the app or is not an address", () => {
    for (const value of ["", "   ", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "forms.example.test", 7, null, undefined, `https://a.test/${"x".repeat(2048)}`]) {
      expect(readFormUrl(value)).toBe("");
    }
  });

  it("uses the caption from settings, and the default when it is empty", () => {
    expect(readConfig({ formUrl: FORM, label: "  Send it  " })).toEqual({ url: FORM, label: "Send it" });
    expect(readConfig({ formUrl: FORM, label: "  " }).label).toBe(DEFAULT_LABEL);
    expect(readConfig({ formUrl: FORM }).label).toBe(DEFAULT_LABEL);
  });
});

describe("button", () => {
  it("keeps the code picture and the plugin icon the same", () => {
    expect(readFileSync(join(import.meta.dirname, "../icon.svg"), "utf8").trim()).toBe(BUG_SVG);
  });

  it("is a link to the form that opens a new window", () => {
    undos.push(showButton(document, { url: FORM, label: "Send it" }));
    const link = button();
    expect(link?.getAttribute("href")).toBe(FORM);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(link?.getAttribute("aria-label")).toBe("Send it");
    expect(link?.title).toBe("Send it");
    expect(link?.querySelector("svg")).not.toBeNull();
  });

  it("stays clickable and on top when a modal dialog is open", () => {
    undos.push(showButton(document, { url: FORM, label: "Send it" }));
    const { position, pointerEvents, zIndex } = button()!.style;
    expect(position).toBe("fixed");
    expect(pointerEvents).toBe("auto");
    expect(Number(zIndex)).toBeGreaterThan(1_000_000);
  });

  it("does not parse the caption as markup", () => {
    const label = '"><img src=x onerror=alert(1)>';
    undos.push(showButton(document, { url: FORM, label }));
    expect(button()?.querySelector("img")).toBeNull();
    expect(button()?.getAttribute("aria-label")).toBe(label);
  });

  it("does not appear without an address, and the undo leaves nothing", () => {
    showButton(document, { url: "", label: "Send it" })();
    expect(document.body.children).toHaveLength(0);
    showButton(document, { url: FORM, label: "Send it" })();
    expect(document.body.children).toHaveLength(0);
  });
});

describe("watching settings", () => {
  it("shows the button from what the server route really answers", async () => {
    let route = (_context: { json: (body: unknown) => unknown }): unknown => undefined;
    const api = {
      settings: { define: () => ({ get: async () => ({ formUrl: FORM, label: "Send it" }) }) },
      http: { route: (_method: string, _path: string, handler: typeof route) => (route = handler) },
    };
    bugReportButton(api as unknown as Parameters<typeof bugReportButton>[0]);
    watch(async () => (await route({ json: (body) => body })) as Record<string, unknown>);
    await settle();
    expect(button()?.getAttribute("href")).toBe(FORM);
    expect(button()?.getAttribute("aria-label")).toBe("Send it");
  });

  it("shows nothing while the address is empty", async () => {
    const load = vi.fn(async () => ({ formUrl: "", label: "Send it" }));
    watch(load);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(button()).toBeNull();
  });

  it("follows settings that arrive or change after the start, keeping one button", async () => {
    vi.useFakeTimers();
    let values: Record<string, unknown> = { formUrl: "" };
    watch(async () => values, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(button()).toBeNull();

    values = { formUrl: FORM, label: "Send it" };
    await vi.advanceTimersByTimeAsync(1000);
    expect(button()?.getAttribute("href")).toBe(FORM);

    values = { formUrl: "https://forms.example.test/other", label: "Send it" };
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
    expect(button()?.getAttribute("href")).toBe("https://forms.example.test/other");

    values = { formUrl: "" };
    await vi.advanceTimersByTimeAsync(1000);
    expect(button()).toBeNull();
  });

  it("does not rebuild the button when nothing changed", async () => {
    vi.useFakeTimers();
    watch(async () => ({ formUrl: FORM }), 1000);
    await vi.advanceTimersByTimeAsync(0);
    const first = button();
    expect(first).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(button()).toBe(first);
  });

  it("keeps the button while the server restarts", async () => {
    vi.useFakeTimers();
    let up = true;
    watch(async () => {
      if (!up) throw new Error("down");
      return { formUrl: FORM };
    }, 1000);
    await vi.advanceTimersByTimeAsync(0);
    up = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(button()).not.toBeNull();
  });

  it("removes the button on stop, also when the answer comes after it", async () => {
    const undo = watch(async () => ({ formUrl: FORM }));
    await settle();
    expect(button()).not.toBeNull();
    undo();
    expect(button()).toBeNull();

    let answer = (_values: Record<string, unknown>) => {};
    const late = watch(() => new Promise((resolve) => (answer = resolve)));
    late();
    answer({ formUrl: FORM });
    await settle();
    expect(button()).toBeNull();
  });
});
