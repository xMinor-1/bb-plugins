// Failures the user reads in toasts and in History, in the interface language.
//
// The host reports failures as a code plus the engine's own English detail
// (a Python error, a worker exit). The code picks a sentence in the current
// language; the detail follows it untranslated, since it is diagnostic output,
// except for the few details the host writes itself, which are translated whole.
import { defineMessages, messagesNow } from "@/lib/i18n";

const messages = defineMessages(
  {
    // Recognition codes, as the host returns them.
    timeout: "Recognition did not finish in time",
    rate_limited: "The recognition model is busy",
    service_unavailable: "The recognition model is unavailable",
    auth_required: "Speech recognition is not set up on this machine",
    request_failed: "Recognition failed",
    invalid_response: "The recognition model returned an unreadable answer",
    // Speech codes from the speech service.
    loading: "The speech service is still starting",
    unreachable: "The speech service is not answering",
    failed: "The speech service failed",
    // Details the host writes itself.
    notConfigured: "Voice Ink is not configured yet",
    audioEmpty: "The recording is empty",
    interrupted: "Recognition was interrupted; the recording is kept",
    // Failures the browser side notices.
    dropped: "Recognition took too long and was dropped",
    micDenied: "Microphone permission denied",
    couldNotSpeak: (reason: string) => `Could not speak the reply: ${reason}`,
  },
  {
    timeout: "Распознавание не успело закончиться",
    rate_limited: "Модель распознавания занята",
    service_unavailable: "Модель распознавания недоступна",
    auth_required: "Распознавание речи на этой машине не настроено",
    request_failed: "Не удалось распознать",
    invalid_response: "Модель распознавания вернула непонятный ответ",
    loading: "Служба озвучки ещё запускается",
    unreachable: "Служба озвучки не отвечает",
    failed: "Ошибка службы озвучки",
    notConfigured: "Voice Ink ещё не настроен",
    audioEmpty: "Запись пустая",
    interrupted: "Распознавание прервалось, запись сохранена",
    dropped: "Распознавание шло слишком долго, кусок пропущен",
    micDenied: "Нет доступа к микрофону",
    couldNotSpeak: (reason) => `Не удалось озвучить ответ: ${reason}`,
  },
);

type Code = Exclude<keyof (typeof messages)["en"], "couldNotSpeak">;

const CODES = new Set<string>([
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
  "loading",
  "unreachable",
  "failed",
]);

/** Details the host writes itself, translated whole instead of quoted. */
const KNOWN_DETAILS: Record<string, Code> = {
  "voice-ink is not configured yet": "notConfigured",
  "audio is empty": "audioEmpty",
  "recognition was interrupted; the recording is still here": "interrupted",
};

function isCode(code: string): code is Code {
  return CODES.has(code);
}

/** A failed recognition or speech request: the code's sentence, then the engine's detail. */
export function describeFailure(code: string, detail: string): string {
  const t = messagesNow(messages);
  const known = KNOWN_DETAILS[detail.trim()];
  if (known !== undefined) return t[known];
  if (!isCode(code)) return detail;
  // A timeout's detail only restates the budget in milliseconds.
  if (code === "timeout" || detail.trim() === "") return t[code];
  return `${t[code]}: ${detail}`;
}

/** A failure stored with a History entry; only the detail survives there. */
export function describeStoredFailure(detail: string | null): string {
  const t = messagesNow(messages);
  if (detail === null || detail.trim() === "") return t.request_failed;
  const known = KNOWN_DETAILS[detail.trim()];
  return known === undefined ? `${t.request_failed}: ${detail}` : t[known];
}

/** An exception from the browser side: the microphone, audio decoding, a lost RPC. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || message.includes("Permission denied") || message.includes("NotAllowedError")) {
    return messagesNow(messages).micDenied;
  }
  return message;
}

export function droppedText(): string {
  return messagesNow(messages).dropped;
}

export function couldNotSpeakText(code: string, detail: string): string {
  return messagesNow(messages).couldNotSpeak(describeFailure(code, detail));
}
