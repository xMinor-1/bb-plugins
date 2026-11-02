// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBranding as apply, type Branding, isUsableLogo, readBranding, svgDataUrl } from "../src/branding";

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const hrefOf = (id: string) => document.getElementById(id)?.getAttribute("href");

let undos: Array<() => void> = [];
const applyBranding = (doc: Document, branding: Branding) => {
  const undo = apply(doc, branding);
  undos.push(undo);
  return undo;
};
afterEach(() => {
  for (const undo of undos) undo();
  undos = [];
});

beforeEach(() => {
  document.head.innerHTML = `<title>bb</title>
    <link rel="icon" id="favicon-32" href="/favicon-32x32.png">
    <link rel="icon" id="favicon-16" href="/favicon-16x16.png">
    <link rel="apple-touch-icon" id="apple-touch-icon" href="/apple-touch-icon.png">`;
});

describe("settings", () => {
  it("accepts SVG source and refuses anything else", () => {
    expect(isUsableLogo(LOGO)).toBe(true);
    expect(isUsableLogo(`<?xml version="1.0"?>\n${LOGO}`)).toBe(true);
    expect(isUsableLogo("<html></html>")).toBe(false);
    expect(isUsableLogo(`<svg>${"x".repeat(70_000)}</svg>`)).toBe(false);
  });

  it("ignores a broken logo and non-string values", () => {
    expect(readBranding({ appName: 5, logoSvg: "<html>" })).toEqual({ appName: "", logoSvg: "" });
    expect(readBranding({ appName: " Acme ", logoSvg: LOGO })).toEqual({ appName: "Acme", logoSvg: LOGO });
  });
});

describe("applyBranding", () => {
  it("replaces the bb title and every icon link", () => {
    applyBranding(document, { appName: "Acme", logoSvg: LOGO });
    expect(document.title).toBe("Acme");
    for (const id of ["favicon-32", "favicon-16", "apple-touch-icon"]) expect(hrefOf(id)).toBe(svgDataUrl(LOGO));
    expect(document.head.querySelector("style")?.textContent).toContain('img[src*="/assets/bb-logo-"]');
  });

  it("keeps them when bb writes its own again, and leaves other titles alone", async () => {
    applyBranding(document, { appName: "Acme", logoSvg: LOGO });
    document.title = "bb";
    document.getElementById("favicon-32")?.setAttribute("href", "/favicon-32x32-dark.png");
    await settle();
    expect(document.title).toBe("Acme");
    expect(hrefOf("favicon-32")).toBe(svgDataUrl(LOGO));
    document.title = "Settings";
    await settle();
    expect(document.title).toBe("Settings");
  });

  it("undoes everything it did", async () => {
    const undo = applyBranding(document, { appName: "Acme", logoSvg: LOGO });
    undo();
    expect(document.title).toBe("bb");
    expect(hrefOf("favicon-16")).toBe("/favicon-16x16.png");
    expect(document.head.querySelector("style")).toBeNull();
    document.title = "bb";
    await settle();
    expect(document.title).toBe("bb");
  });

  it("does nothing without settings, and only the name without a logo", () => {
    applyBranding(document, { appName: "", logoSvg: "" });
    expect(document.title).toBe("bb");
    applyBranding(document, { appName: "Acme", logoSvg: "" });
    expect(document.title).toBe("Acme");
    expect(hrefOf("favicon-32")).toBe("/favicon-32x32.png");
  });
});
