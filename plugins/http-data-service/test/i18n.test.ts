// Every failure code has a sentence for a person in both languages.
import { describe, expect, it } from "vitest";
import { failureCodeSchema } from "../contract";
import { messages } from "../src/app/messages";

describe("failure messages", () => {
  it.each([...failureCodeSchema.options, "notConfigured"])("%s", (code) => {
    expect(messages.en.failure(code)).not.toBe(code);
    expect(messages.ru.failure(code)).not.toBe(code);
    expect(messages.ru.failure(code)).toMatch(/[а-я]/);
  });
});
