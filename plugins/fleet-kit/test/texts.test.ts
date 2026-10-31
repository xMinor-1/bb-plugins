import { describe, expect, it } from "vitest";
import { render, say, storeName, TEXTS, type TextCode } from "../src/shared/texts.js";

// Any parameter a text asks for: a word, or 2 where it counts.
const sample = new Proxy({}, { get: (_, key) => (key === "attempts" || key === "seconds" ? 2 : key === "next" || key === "retry" ? "2026-11-01T10:00:00Z" : "x") });

describe("panel texts", () => {
  it("has its own Russian for every code", () => {
    const codes = Object.keys(TEXTS.en) as TextCode[];
    expect(codes.length).toBeGreaterThan(50);
    for (const code of codes) {
      if (code === "raw") continue;
      const en = (TEXTS.en[code] as (p: unknown) => string)(sample);
      const ru = (TEXTS.ru[code] as (p: unknown) => string)(sample);
      expect(ru, code).not.toBe(en);
      expect(ru, code).toMatch(/[а-яё]/i);
    }
  });

  it("shows a stored text in either language and falls back to the English copy", () => {
    const text = say("installed", { version: "1.2.0" });
    expect(text.message).toBe("Installed 1.2.0.");
    expect(render("ru", text)).toBe("Установлен 1.2.0.");
    expect(render("ru", { code: "fromNewerFleetKit", params: {}, message: "Something new." })).toBe("Something new.");
    // Steps saved by 0.1.x have no code; known OpenCode check texts still read in Russian.
    expect(render("ru", { message: "OpenCode's available models could not be checked.." })).toBe("Не удалось проверить, какие модели доступны в OpenCode.");
    expect(render("en", { message: "Plain." })).toBe("Plain.");
  });

  it("names secret stores in Russian", () => {
    expect(storeName("macOS Keychain", "ru")).toBe("Связка ключей macOS");
    expect(storeName("file (/home/a/.local/share/fleet-kit/secrets)", "ru")).toBe("файл (/home/a/.local/share/fleet-kit/secrets)");
    expect(storeName("macOS Keychain", "en")).toBe("macOS Keychain");
  });
});
