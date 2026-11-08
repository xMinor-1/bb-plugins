// Texts the server writes for people: the queued-message card, the error an
// agent shows when a request is refused, and the setup step in Fleet Kit.
// The app tells the server its language (RPC input `lang`); until it does,
// English. Technical detail (an HTTP code, a path) stays in parentheses.

import type { Lang, ProxyStatus } from "./shared";

/** One sentence on where the proxy is, without a full stop. */
export function proxyState(status: ProxyStatus, lang: Lang): string {
  const ru = lang === "ru";
  const detail = status.message === null ? "" : ` (${status.message})`;
  switch (status.state) {
    case "running":
      return ru ? "Прокси обфускации работает" : "The masking proxy is running";
    case "installing":
      return ru ? "Прокси обфускации ещё скачивается" : "The masking proxy is still downloading";
    case "starting":
      return ru ? "Прокси обфускации запускается" : "The masking proxy is starting";
    case "not-configured":
      if (status.problem === "no-file")
        return ru ? `Прокси обфускации не установлен: нет файла${detail}` : `The masking proxy is not installed: no file${detail}`;
      return ru
        ? "Прокси обфускации не установлен: в настройках плагина нет адреса загрузки"
        : "The masking proxy is not installed: the plugin settings have no download URL";
    case "failed":
      if (status.problem === "download")
        return ru ? `Прокси обфускации не скачался${detail}` : `The masking proxy did not download${detail}`;
      return ru ? `Прокси обфускации не запустился${detail}` : `The masking proxy did not start${detail}`;
    case "stopped":
      return ru ? "Прокси обфускации остановлен" : "The masking proxy is stopped";
  }
}

/** Whether the plugin retries by itself; settings changes always restart it. */
function retries(status: ProxyStatus): boolean {
  return status.state === "installing" || status.state === "starting" || status.state === "failed";
}

/** Why a message to an external model waits in the queue. */
export function waitReason(status: ProxyStatus, lang: Lang): string {
  const ru = lang === "ru";
  const off = ru
    ? "Чтобы отправить без маскировки, выключите обфускацию над полем ввода."
    : "To send it unmasked, turn masking off above the message box.";
  const next = retries(status)
    ? ru
      ? status.state === "failed"
        ? "Плагин пробует снова, сообщение уйдёт само, когда прокси запустится."
        : "Сообщение уйдёт само, когда прокси запустится."
      : status.state === "failed"
        ? "The plugin keeps trying; the message goes out by itself once the proxy runs."
        : "The message goes out by itself once the proxy runs."
    : ru
      ? "Сообщение ждёт."
      : "The message waits.";
  return `${proxyState(status, lang)}. ${next} ${off}`;
}

/** The error an agent shows when a request with masking on cannot go through the proxy. */
export function refusedMessage(status: ProxyStatus, lang: Lang): string {
  return lang === "ru"
    ? `Обфускация в этом треде включена. ${proxyState(status, lang)}. Ничего не отправлено. ` +
        "Подождите, пока он запустится, или выключите обфускацию над полем ввода."
    : `Masking is on for this thread. ${proxyState(status, lang)}. Nothing was sent. ` +
        "Wait for it to start, or turn masking off above the message box."
}

export interface SetupAnswer {
  state: "done" | "todo" | "problem";
  summary: string;
}

/** The plugin's line on Fleet Kit's "First run" page, at most 200 characters. */
export function setupAnswer(status: ProxyStatus, lang: Lang): SetupAnswer {
  const ru = lang === "ru";
  const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);
  const state =
    status.state === "running"
      ? "done"
      : status.state === "installing" || status.state === "starting"
        ? "todo"
        : "problem";
  let summary = proxyState(status, lang);
  if (state === "todo") summary += ru ? ", сообщения своим агентам ждут" : "; messages to external agents wait";
  return { state, summary: clip(summary) };
}
