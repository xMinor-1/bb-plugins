import { expect, it } from "vitest";
import { readSendChoice, writeSendChoice } from "./send-choice";

it("defaults to queue and remembers each send option across mounts", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  expect(readSendChoice(storage)).toBe("queue");
  for (const choice of ["immediate", "new", "queue"] as const) {
    writeSendChoice(storage, choice);
    expect(readSendChoice(storage)).toBe(choice);
  }
  expect(readSendChoice({ getItem: () => "invalid" })).toBe("queue");
});
