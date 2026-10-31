// The shared language module: Russian plurals and both halves of the texts.
import { describe, expect, it } from "vitest";
import { defineMessages, getLang, pluralRu } from "../lib/i18n";

describe("pluralRu", () => {
  const forms = ["приложение", "приложения", "приложений"] as const;
  it.each([
    [0, "приложений"], [1, "приложение"], [2, "приложения"], [4, "приложения"], [5, "приложений"],
    [11, "приложений"], [12, "приложений"], [14, "приложений"], [21, "приложение"], [22, "приложения"],
    [63, "приложения"], [111, "приложений"], [1.5, "приложения"],
  ])("%d → %s", (n, expected) => expect(pluralRu(n, forms)).toBe(expected));
});

describe("defineMessages", () => {
  it("keeps both languages with the same arguments", () => {
    const messages = defineMessages(
      { save: "Save", apps: (n: number) => `${n} apps` },
      { save: "Сохранить", apps: (n) => `${n} ${pluralRu(n, ["приложение", "приложения", "приложений"])}` },
    );
    expect(messages.ru.apps(63)).toBe("63 приложения");
    expect(messages.en.save).toBe("Save");
  });

  it("requires every key in the Russian half", () => {
    // @ts-expect-error the Russian half lacks "b"
    expect(defineMessages({ a: "A", b: "B" }, { a: "А" }).en.b).toBe("B");
  });

  it("falls back to a language without browser storage", () => {
    expect(["en", "ru"]).toContain(getLang());
  });
});
