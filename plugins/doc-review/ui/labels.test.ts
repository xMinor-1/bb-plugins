import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorLabel, replyAuthor, type Anchor } from "../src/types";
import { authorWords, countWords, localizeError, placeWords } from "./labels";

function pickLang(lang: "en" | "ru") {
  vi.stubGlobal("localStorage", {
    getItem: () => lang,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("panel labels", () => {
  const area: Anchor = { kind: "page-area", page: 3, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, text: "" };

  it("names a place in English by default and in Russian when asked", () => {
    expect(anchorLabel(area, "presentation")).toBe("Slide 3, area");
    expect(anchorLabel(area, "pdf", placeWords.ru)).toBe("Страница 3, область");
    expect(anchorLabel({ kind: "doc" }, "md", placeWords.ru)).toBe("Весь документ");
  });

  it("names who wrote a reply in Russian", () => {
    const reply = { id: "r1", author: "agent" as const, name: "Иван", originId: null, body: "", outcome: null, createdAt: 0, sentAt: 0 };
    expect(replyAuthor(reply)).toBe("Иван's agent");
    expect(replyAuthor(reply, authorWords.ru)).toBe("Агент (Иван)");
  });

  it("counts comments with the Russian plural", () => {
    expect([1, 2, 5, 11, 21].map(countWords.ru.comments)).toEqual([
      "1 комментарий",
      "2 комментария",
      "5 комментариев",
      "11 комментариев",
      "21 комментарий",
    ]);
  });

  it("translates the server's errors for a Russian panel only", () => {
    pickLang("ru");
    expect(localizeError("The file is gone: /tmp/a.md")).toBe("Файла больше нет: /tmp/a.md");
    expect(localizeError("Something unexpected")).toBe("Something unexpected");
    pickLang("en");
    expect(localizeError("The file is gone: /tmp/a.md")).toBe("The file is gone: /tmp/a.md");
  });
});
