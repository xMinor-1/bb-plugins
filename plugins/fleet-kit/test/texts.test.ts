import { describe, expect, it } from "vitest";
import { render, say, stepErrorText, storeName, TEXTS, type TextCode } from "../src/shared/texts.js";
import { checkAccount } from "../src/account.js";
import { checkSecretValue, KEYCHAIN_CHANGED } from "../src/secret-store.js";

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

  it("words a step's errors for the person, in both languages", () => {
    const thrown = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("did not throw");
    };
    const raws = [
      thrown(() => checkAccount("a:b", "x")),
      thrown(() => checkAccount("user", "")),
      thrown(() => checkAccount("u".repeat(300), "x")),
      thrown(() => checkSecretValue(" ")),
      thrown(() => checkSecretValue("x".repeat(9000))),
      thrown(() => checkSecretValue("a\u0001b")),
      KEYCHAIN_CHANGED,
      "macOS Keychain write failed (security exit 51)",
      "macOS Keychain did not keep the secret",
      "macOS Keychain read failed (security exit 1)",
      "Windows Credential Manager write failed (PowerShell exit 1); a policy may block Add-Type, set secretStore to \"file\"",
    ];
    for (const raw of raws) {
      const en = stepErrorText(raw, "en");
      const ru = stepErrorText(raw, "ru");
      expect(en, raw).not.toMatch(/^That did not work/);
      expect(ru, raw).toMatch(/[а-яё]/i);
      expect(ru, raw).not.toBe(en);
    }
    expect(stepErrorText("Network is down", "en")).toBe("That did not work: Network is down");
    expect(stepErrorText("Network is down", "ru")).toBe("Не получилось: Network is down");
  });
});
