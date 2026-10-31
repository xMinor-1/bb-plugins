import { describe, expect, it } from "vitest";

import { asksUser, decide, isAgentJob, jobText, wantsNewChat } from "../src/compose";

describe("dictation inside a card", () => {
  it.each([
    ["Добавь, что ставки нужны с НДС и сразу на декабрь", "note", "Ставки нужны с НДС и сразу на декабрь"],
    ["Допиши, что код получения 4417", "note", "Код получения 4417"],
    ["полис заканчивается седьмого ноября", "note", "Полис заканчивается седьмого ноября"],
    ["Позвонить после обеда, если не ответит — написать в телеграм", "note", "Позвонить после обеда, если не ответит — написать в телеграм"],
    ["Попроси агента сравнить ставки за октябрь и ноябрь и свести в таблицу", "chat", "Сравнить ставки за октябрь и ноябрь и свести в таблицу"],
    ["Найди, какие документы нужны для продления", "chat", "Найди, какие документы нужны для продления"],
    ["найди письмо про тарифы, положи его во вложения и подготовь ответ", "chat", "Найди письмо про тарифы, положи его во вложения и подготовь ответ"],
    ["Проверьте, пришёл ли счёт", "chat", "Проверьте, пришёл ли счёт"],
    ["ask the agent to compare prices", "chat", "Compare prices"],
    ["add that the code is 4417", "note", "The code is 4417"],
    ["a book about negotiations", "note", "A book about negotiations"],
  ])("%s", (phrase, type, text) => {
    expect(decide(phrase)).toEqual({ type, text });
  });

  it("an answer to the agent's question goes to the agent", () => {
    expect(decide("пятница в 12", { agentAsks: true })).toEqual({ type: "chat", text: "Пятница в 12" });
    expect(decide("добавь, что в пятницу в 12", { agentAsks: true })).toEqual({ type: "note", text: "В пятницу в 12" });
  });

  it("with a chat going, the card talks to it", () => {
    expect(decide("умножь результат на два", { chatLive: true })).toEqual({ type: "chat", text: "Умножь результат на два" });
    expect(decide("умножь результат на два")).toEqual({ type: "note", text: "Умножь результат на два" });
    expect(decide("запиши, что код 4417", { chatLive: true })).toEqual({ type: "note", text: "Код 4417" });
  });

  it("a new chat on request", () => {
    expect(wantsNewChat("в новом чате найди тарифы")).toBe(true);
    expect(decide("в новом чате найди тарифы")).toEqual({ type: "chat", text: "Найди тарифы" });
  });
});

describe("jobs for an agent on the board", () => {
  it.each([
    ["Попроси агента сравнить тарифы на страховку", true],
    ["Агент, собери ставки за октябрь", true],
    ["Найди письмо от поставщика про тарифы и подготовь ответ", true],
    ["Найди в почте договор аренды за прошлый год и пришли основные условия", true],
    ["Найди подарок маме", false],
    ["Надо найти подарок маме и купить открытку", false],
    ["Завтра в 10 позвонить в сервис насчёт ТО", false],
    ["Сходить поесть в 16 15", false],
  ])("%s", (phrase, job) => {
    expect(isAgentJob(phrase)).toBe(job);
  });

  it("drops the address to the agent", () => {
    expect(jobText("попроси агента сравнить тарифы")).toBe("Сравнить тарифы");
  });
});

describe("an agent waiting for the user", () => {
  it.each([
    ["Какой вариант по времени рассматриваешь? И отправить ответ?", true],
    ["Слоты:\n\n- пятница 12:00\n\nКакой выбираешь?**", true],
    ["Готово, черновик в заметках.", false],
    [null, false],
  ])("%s", (answer, waits) => {
    expect(asksUser(answer)).toBe(waits);
  });
});
