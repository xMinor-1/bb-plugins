// The message the plugin posts into the thread when it moves the turn to the
// next model. Both the agent and the person read it: the agent learns why the
// turn moved and that work may already be half done, the person sees which
// model took over and why.

import { reasonText, type FallbackReason } from "../shared/reason";

export type MessageLanguage = "English" | "Русский";
export const MESSAGE_LANGUAGES: readonly MessageLanguage[] = ["English", "Русский"];

function ruReason(reason: FallbackReason): string {
  const status = "status" in reason && reason.status !== null ? ` (${reason.status})` : "";
  switch (reason.kind) {
    case "rate-limit":
      return `упёрлась в лимит запросов${status}`;
    case "overloaded":
      return `перегружена${status}`;
    case "server-error":
      return `ответила ошибкой сервера${status}`;
    case "timeout":
      return "не ответила вовремя";
    case "thinking":
      return `думала ${reason.minutes} мин без ответа`;
    case "answering":
      return `застряла посреди ответа на ${reason.minutes} мин`;
    case "silent":
      return `ничего не присылала ${reason.minutes} мин`;
  }
}

function stopped(reason: FallbackReason): boolean {
  return reason.kind === "thinking" || reason.kind === "answering" || reason.kind === "silent";
}

export interface ContinueMessageInput {
  language: MessageLanguage;
  fromName: string;
  toName: string;
  reason: FallbackReason;
  /** The original request never reached the model and is sent again below. */
  resending: boolean;
}

export function continueMessage(input: ContinueMessageInput): string {
  const { fromName, toName, reason, resending } = input;
  if (input.language === "Русский") {
    const head = `Запасная модель: «${fromName}» ${ruReason(reason)}, ход ${stopped(reason) ? "остановлен" : "прервался"}.`;
    if (resending) return `${head} Запрос ниже до неё не дошёл, его выполняет «${toName}».`;
    return `${head} Продолжи на «${toName}» с того места, где остановился; сначала проверь, что уже сделано, и не повторяй сделанное.`;
  }
  const head = `Fallback model: "${fromName}" ${reasonText(reason)}, so the turn was ${stopped(reason) ? "stopped" : "interrupted"}.`;
  if (resending) return `${head} The request below never reached it; "${toName}" takes it now.`;
  return `${head} Continue on "${toName}" from where it stopped; check what is already done first and do not repeat it.`;
}
