import { describe, expect, it } from "vitest";

import { decide } from "../src/compose";

describe("dictation inside a card", () => {
  it.each([
    ["Добавь, что ставки нужны с НДС и сразу на декабрь", "note", "Ставки нужны с НДС и сразу на декабрь"],
    ["Допиши, что код получения 4417", "note", "Код получения 4417"],
    ["полис заканчивается седьмого ноября", "note", "Полис заканчивается седьмого ноября"],
    ["Попроси агента сравнить ставки за октябрь и ноябрь и свести в таблицу", "chat", "Сравнить ставки за октябрь и ноябрь и свести в таблицу"],
    ["Найди, какие документы нужны для продления", "chat", "Найди, какие документы нужны для продления"],
    ["ask the agent to compare prices", "chat", "Compare prices"],
    ["add that the code is 4417", "note", "The code is 4417"],
  ])("%s", (phrase, type, text) => {
    expect(decide(phrase)).toEqual({ type, text });
  });
});
