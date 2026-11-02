// What the panel shows for a failure from the host or the server. Known failures arrive behind a
// tag, `[express:<code>]` (src/shared/errors.ts), and are shown in the panel's language. Anything
// else is shown as it came, in English.
import { defineMessages, useMessages } from "@/lib/i18n";
import { codeOf, untagged, type PanelCode } from "../shared/errors";

export const hostErrors = defineMessages(
  {
    "sign-in": "The messenger asks to sign in. Press Sign in for this machine.",
    unreachable: "The messenger does not open from this machine. Check the network or VPN; watch rules look again by themselves.",
    "no-browser": "No Chromium-based browser found: install Google Chrome, Microsoft Edge or Chromium.",
    busy: "A sign-in window is open on this machine. Finish signing in first.",
    "not-confirmed": "The rule was not confirmed in the window on the machine, so it was not added.",
    "window-timeout": "Nobody answered the window on the machine in time, so the rule was not added.",
    "window-unavailable": "The confirmation window did not open on that machine (no desktop session, or the window was blocked), so the rule was not added.",
    "window-busy": "Another request is waiting in a window on that machine. Answer it first; this rule was not added.",
    "not-in-directory": "This chat is not in the directory on that machine. Update the directory and try again.",
  } satisfies Record<PanelCode, string>,
  {
    "sign-in": "Мессенджер просит войти. Нажмите «Войти» для этой машины.",
    unreachable: "Мессенджер не открывается с этой машины. Проверьте сеть или VPN; правила сторожа проверят снова сами.",
    "no-browser": "Не найден браузер на Chromium: поставьте Google Chrome, Microsoft Edge или Chromium.",
    busy: "На этой машине открыто окно входа. Сначала закончите вход.",
    "not-confirmed": "Правило не подтвердили в окне на машине, поэтому оно не добавлено.",
    "window-timeout": "В окне на машине вовремя не ответили, поэтому правило не добавлено.",
    "window-unavailable": "Окно подтверждения не открылось на той машине (нет рабочего стола или окно заблокировано), поэтому правило не добавлено.",
    "window-busy": "На той машине другой запрос ждёт ответа в окне. Сначала ответьте на него; это правило не добавлено.",
    "not-in-directory": "Этого чата нет в справочнике на той машине. Обновите справочник и попробуйте снова.",
  },
);

type HostErrorTexts = (typeof hostErrors)["en"];

/** The text to show for a failure from the host or the server. */
export function explain(texts: HostErrorTexts, raw: string): string {
  const code = codeOf(raw);
  if (!code) return raw;
  // An unknown code, from a newer host than this panel, keeps the English text without the tag.
  return Object.hasOwn(texts, code) ? texts[code as PanelCode] : untagged(raw);
}

/** `explain` in the panel's current language: call it when rendering, so a language switch reaches stored errors too. */
export function useHostError(): (raw: string) => string {
  const texts = useMessages(hostErrors);
  return (raw) => explain(texts, raw);
}
