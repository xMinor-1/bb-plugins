// Interface text in English and Russian.
import { defineMessages, pluralRu } from "@/lib/i18n";
import type { FallbackReason } from "../shared/reason";
import type { NotSwitchedWhy } from "../shared/state";

type Reason = (reason: FallbackReason) => string;

const enReason: Reason = (reason) => {
  const status = "status" in reason && reason.status !== null ? ` (${reason.status})` : "";
  switch (reason.kind) {
    case "rate-limit":
      return `rate limit${status}`;
    case "overloaded":
      return `overloaded${status}`;
    case "server-error":
      return `server error${status}`;
    case "timeout":
      return "timed out";
    case "thinking":
      return `thinking ${reason.minutes} min without an answer`;
    case "answering":
      return `stalled mid-answer for ${reason.minutes} min`;
    case "silent":
      return `silent for ${reason.minutes} min`;
  }
};

const ruMinutes = (n: number) => `${n} ${pluralRu(n, ["минуту", "минуты", "минут"])}`;

const ruReason: Reason = (reason) => {
  const status = "status" in reason && reason.status !== null ? ` (${reason.status})` : "";
  switch (reason.kind) {
    case "rate-limit":
      return `лимит запросов${status}`;
    case "overloaded":
      return `перегружена${status}`;
    case "server-error":
      return `ошибка сервера${status}`;
    case "timeout":
      return "не ответила вовремя";
    case "thinking":
      return `думает ${ruMinutes(reason.minutes)} без ответа`;
    case "answering":
      return `застряла посреди ответа на ${ruMinutes(reason.minutes)}`;
    case "silent":
      return `молчит ${ruMinutes(reason.minutes)}`;
  }
};

const enWhy = (why: NotSwitchedWhy): string =>
  ({
    connection: "no connection to the model server, another model would fail the same way",
    auth: "the key was refused, another model would not help",
    request: "the request was rejected, not a model failure",
    unknown: "unclear error, not switching",
  })[why];

const ruWhy = (why: NotSwitchedWhy): string =>
  ({
    connection: "нет связи с сервером моделей, другая модель упала бы так же",
    auth: "ключ не принят, другая модель не поможет",
    request: "запрос отклонён, дело не в модели",
    unknown: "непонятная ошибка, модель не меняю",
  })[why];

export const messages = defineMessages(
  {
    title: "Model fallback",
    reason: enReason,
    why: enWhy,
    pending: (from: string, reason: string, to: string, left: string) => `${from}: ${reason}. Continuing on ${to} in ${left}`,
    pendingNow: (from: string, reason: string, to: string) => `${from}: ${reason}. Switching to ${to}…`,
    cancelled: (from: string) => `Switch cancelled. The thread keeps waiting for ${from}`,
    active: (to: string, from: string, reason: string) => `Fallback model ${to} instead of ${from}: ${reason}`,
    noFallback: (model: string, reason: string) => `${model}: ${reason}. No fallback model left`,
    notSwitched: (model: string, why: string) => `${model}: ${why}`,
    now: "Switch now",
    cancel: "Cancel",
    switchTo: (to: string) => `Switch to ${to}`,
    back: (to: string) => `Return ${to}`,
    logSwitched: (from: string, to: string) => `${from} → ${to}`,
    logCancelled: (from: string, to: string) => `${from} → ${to} cancelled`,
    logReturned: (to: string) => `Returned to ${to}`,
    logNoFallback: (model: string) => `${model}: no fallback left`,
    logRecovered: (model: string) => `${model} came back, no switch`,
    logFailed: (from: string, to: string) => `${from} → ${to} failed`,
    ladder: (names: string) => `Ladder: ${names}. Only models from the allowed list are ever used.`,
    tag: (from: string, to: string) => `Fallback model, sent automatically: ${from} → ${to}`,
    actionFailed: "Did not work, try again",
  },
  {
    title: "Запасная модель",
    reason: ruReason,
    why: ruWhy,
    pending: (from, reason, to, left) => `${from}: ${reason}. Продолжу на ${to} через ${left}`,
    pendingNow: (from, reason, to) => `${from}: ${reason}. Переключаю на ${to}…`,
    cancelled: (from) => `Переключение отменено. Тред ждёт ${from}`,
    active: (to, from, reason) => `Запасная модель ${to} вместо ${from}: ${reason}`,
    noFallback: (model, reason) => `${model}: ${reason}. Запасных моделей не осталось`,
    notSwitched: (model, why) => `${model}: ${why}`,
    now: "Сейчас",
    cancel: "Отменить",
    switchTo: (to) => `Переключить на ${to}`,
    back: (to) => `Вернуть ${to}`,
    logSwitched: (from, to) => `${from} → ${to}`,
    logCancelled: (from, to) => `${from} → ${to} отменено`,
    logReturned: (to) => `Вернули ${to}`,
    logNoFallback: (model) => `${model}: запасных не осталось`,
    logRecovered: (model) => `${model} ожила, не переключали`,
    logFailed: (from, to) => `${from} → ${to} не вышло`,
    ladder: (names) => `Лестница: ${names}. Другие модели не используются: только из разрешённого списка.`,
    tag: (from, to) => `Запасная модель, отправлено автоматически: ${from} → ${to}`,
    actionFailed: "Не получилось, попробуйте ещё раз",
  },
);
