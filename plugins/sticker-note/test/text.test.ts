import { describe, expect, it } from "vitest";

import { clip, firstSentence, plainText } from "../src/text";

describe("chat message to sticker text", () => {
  it("drops markdown", () => {
    const md = "К сожалению, на **вторник 3 ноября** занято.\n\n- **Пятница 6 ноября, 12:00–14:00** — идеально\n1. [Письмо](https://mail.example.com/x) по теме";
    expect(plainText(md)).toBe(
      "К сожалению, на вторник 3 ноября занято.\n\nПятница 6 ноября, 12:00–14:00 — идеально\nПисьмо https://mail.example.com/x по теме",
    );
  });

  it("keeps snake_case and arithmetic", () => {
    expect(plainText("run sticker_note_add, 2 * 3 * 4")).toBe("run sticker_note_add, 2 * 3 * 4");
  });

  it("takes the first sentence as the title", () => {
    expect(firstSentence("Ассессмент требует ~2 часа. Ближайшие слоты на этой неделе:")).toBe("Ассессмент требует ~2 часа");
    expect(firstSentence("\n\nПятница 6 ноября, 12:00–14:00 — идеально 2 часа\nещё")).toBe("Пятница 6 ноября, 12:00–14:00 — идеально 2 часа");
  });

  it("clips at a word", () => {
    expect(clip("один два три четыре", 12)).toBe("один два…");
    expect(clip("коротко", 12)).toBe("коротко");
  });
});
