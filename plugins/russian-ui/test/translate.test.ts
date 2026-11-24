// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { inScope, isSettingsPath, startTranslator, translateText, type Dictionary } from "../src/translate";
import { dictionary } from "../src/dictionary";

const dict: Dictionary = {
  exact: { General: "Общие", "Copy on select": "Копировать при выделении", Search: "Поиск" },
  patterns: [[/^Update to (\S+)$/, "Обновить до $1"]],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.innerHTML = "";
  history.replaceState({}, "", "/");
});

describe("translateText", () => {
  it("keeps the surrounding spaces and folds inner ones for the lookup", () => {
    expect(translateText("  Copy  on\nselect ", dict)).toBe("  Копировать при выделении ");
  });
  it("uses patterns when there is no exact match", () => {
    expect(translateText("Update to 0.2.1", dict)).toBe("Обновить до 0.2.1");
  });
  it("returns null for unknown text", () => {
    expect(translateText("My project", dict)).toBeNull();
  });
});

describe("scope", () => {
  it("knows settings routes", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/plugins/chime")).toBe(true);
    expect(isSettingsPath("/settingsx")).toBe(false);
    expect(isSettingsPath("/threads/thr_1")).toBe(false);
  });

  it("translates settings screens only on settings routes", () => {
    document.body.innerHTML = `<div data-testid="app-layout-content-shell"><p id="a">General</p></div>`;
    const text = document.getElementById("a")!.firstChild!;
    expect(inScope(text, false)).toBe(false);
    expect(inScope(text, true)).toBe(true);
  });

  it("leaves code, inputs and the command palette alone even inside a dialog", () => {
    document.body.innerHTML = `<div role="dialog"><code id="c">General</code><div cmdk-root><span id="k">Search</span></div><p id="p">General</p></div>`;
    expect(inScope(document.getElementById("c")!.firstChild!, false)).toBe(false);
    expect(inScope(document.getElementById("k")!.firstChild!, false)).toBe(false);
    expect(inScope(document.getElementById("p")!.firstChild!, false)).toBe(true);
  });
});

describe("startTranslator", () => {
  it("translates what is there, what appears later and what bb rewrites, and the undo brings English back", async () => {
    history.replaceState({}, "", "/settings");
    document.body.innerHTML = `
      <nav id="threads"><span>General</span></nav>
      <div data-testid="app-layout-content-shell"><h2 id="h">General</h2><input id="i" placeholder="Search"></div>`;
    const stop = startTranslator(document, dict);
    const h = document.getElementById("h")!;
    expect(h.textContent).toBe("Общие");
    expect(document.getElementById("i")!.getAttribute("placeholder")).toBe("Поиск");
    expect(document.getElementById("threads")!.textContent).toBe("General");

    const added = document.createElement("p");
    added.textContent = "Copy on select";
    document.querySelector('[data-testid="app-layout-content-shell"]')!.append(added);
    await tick();
    expect(added.textContent).toBe("Копировать при выделении");

    h.firstChild!.nodeValue = "Search";
    await tick();
    expect(h.textContent).toBe("Поиск");

    stop();
    expect(h.textContent).toBe("Search");
    expect(added.textContent).toBe("Copy on select");
    expect(document.getElementById("i")!.getAttribute("placeholder")).toBe("Search");
  });

  it("does not translate a dialog's text box or a thread page outside dialogs", async () => {
    history.replaceState({}, "", "/threads/thr_1");
    document.body.innerHTML = `<main data-testid="app-layout-content-shell"><p id="m">General</p></main>`;
    const stop = startTranslator(document, dict);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `<h2>General</h2><textarea>General</textarea>`;
    document.body.append(dialog);
    await tick();
    expect(document.getElementById("m")!.textContent).toBe("General");
    expect(dialog.querySelector("h2")!.textContent).toBe("Общие");
    expect(dialog.querySelector("textarea")!.value).toBe("General");
    stop();
  });
});

describe("dictionary", () => {
  it("has no empty, unchanged or middle-dot translations", () => {
    const entries = Object.entries(dictionary.exact);
    expect(entries.length).toBeGreaterThan(500);
    for (const [en, ru] of entries) {
      expect(ru.trim(), en).not.toBe("");
      expect(ru, en).not.toBe(en);
      expect(ru.includes("·") && !en.includes("·"), en).toBe(false);
    }
  });
  it("keys are already in lookup form", () => {
    for (const en of Object.keys(dictionary.exact)) expect(en).toBe(en.replace(/\s+/g, " ").trim());
  });
});

describe("what stays English", () => {
  it("skips the command palette, command previews and rendered markdown", () => {
    document.body.innerHTML = `
      <div role="dialog" data-testid="command-palette"><p id="a">General</p></div>
      <div data-testid="tool-use-ask"><div data-testid="command-preview"><span id="b">General</span></div><p id="c">General</p></div>
      <div role="dialog"><div class="prose"><p id="d">General</p></div></div>`;
    const stop = startTranslator(document, dict);
    expect(document.getElementById("a")!.textContent).toBe("General");
    expect(document.getElementById("b")!.textContent).toBe("General");
    expect(document.getElementById("c")!.textContent).toBe("Общие");
    expect(document.getElementById("d")!.textContent).toBe("General");
    stop();
  });
});
