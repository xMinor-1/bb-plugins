import { describe, expect, it } from "vitest";
import { findBest, lookKey, phonetic, score } from "../src/shared/match";

// A made-up directory: near pairs are on purpose.
const DIR = [
  { name: "Alexander Volkov" },
  { name: "Alexandra Volkova" },
  { name: "Aleksey Volkonsky" },
  { name: "Dmitry Ivanov" },
  { name: "Yuriy Petrov" },
  { name: "Team CP" },
  { name: "Т2 ЦП" },
  { name: "Transport news" },
  { name: "Volkov team chat" },
];
const top = (q: string) => findBest(q, DIR).matches[0]?.entry.name;

describe("match", () => {
  it("brings spellings of one name together", () => {
    expect(phonetic("Юрий")).toBe(phonetic("Yuriy"));
    expect(phonetic("Iurii")).toBe(phonetic("Yuri"));
    expect(lookKey("Т2 ЦП")).toBe("t2cp");
  });

  it("finds a Latin name from Cyrillic words in any order", () => {
    expect(top("Волков Александр")).toBe("Alexander Volkov");
    expect(top("Александр Волков")).toBe("Alexander Volkov");
    expect(top("Юрий Петров")).toBe("Yuriy Petrov");
  });

  it("knows diminutives", () => {
    expect(top("Саша Волков")).toBe("Alexander Volkov");
    expect(top("Дима")).toBe("Dmitry Ivanov");
    expect(top("dima ivanov")).toBe("Dmitry Ivanov");
  });

  it("finds a chat named with mixed alphabets", () => {
    for (const q of ["t2cp", "т2цп", "Т2 ЦП", "t2 cp"]) expect(top(q)).toBe("Т2 ЦП");
  });

  it("returns several for a word start and nothing for noise", () => {
    expect(findBest("Вол", DIR).matches.length).toBeGreaterThanOrEqual(2);
    expect(findBest("Абракадабра", DIR).matches).toHaveLength(0);
  });

  it("marks close candidates as ambiguous, stricter for sending", () => {
    expect(findBest("Волков", DIR, { strict: true }).ambiguous).toBe(true);
    expect(findBest("Волков Александр", DIR, { strict: true }).ambiguous).toBe(false);
    expect(score("Волков", "Alexander Volkov")).toBeGreaterThan(score("Волков", "Aleksey Volkonsky"));
    // "Sasha" fits both Alexander and Alexandra; the surname tells them apart.
    const sasha = findBest("Саша Волков", DIR, { strict: true });
    expect(sasha.matches[0]?.entry.name).toBe("Alexander Volkov");
    expect(sasha.ambiguous).toBe(false);
    expect(findBest("Саша Волкова", DIR, { strict: true }).matches[0]?.entry.name).toBe("Alexandra Volkova");
  });
});
