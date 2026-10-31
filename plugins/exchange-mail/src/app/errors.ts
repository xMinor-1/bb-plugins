// What the panel shows for a failure from the host or the server. Known
// failures arrive behind a tag — `[mail:<code>]` or `[mail:<code>:<param>]`,
// written by src/host/errors.ts — and are shown in the panel's language.
// Anything else is shown as it came, in English. curl's own words stay
// English inside the translation: they are for IT.
import { defineMessages, intlLocale, useMessages, type Lang } from "@/lib/i18n";

const clock = (lang: Lang, at: string) => {
  const ms = Number(at);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleTimeString(intlLocale(lang), { hour: "2-digit", minute: "2-digit" }) : "";
};
const curlSaid = (detail: string) => (detail ? ` (curl: ${detail})` : "");

export const hostErrors = defineMessages(
  {
    "not-connected": "Mail is not connected on this machine yet. Connect it in Settings on this page.",
    "password-missing": "The mail password is missing on this machine. Enter it again in Settings on this page.",
    "password-required": "Enter the password.",
    "password-other-account": "The saved password was for the previous address or login, so bb removed it. Enter the password for this one.",
    "login-required": "Enter the login, for example DOMAIN\\name or name@company.com.",
    "bad-address": "Enter the Exchange address, for example https://mail.example.com/EWS/Exchange.asmx.",
    "https-required": "The Exchange address must start with https://.",
    "login-in-address": "Do not put the login into the address: it has a field of its own.",
    "signin-paused": (at: string) =>
      `Mail sign-in is paused: Exchange did not accept the login and password. So that the domain does not lock the account, bb tries again no earlier than ${clock("en", at)}, whoever asks. Check the password in Settings meanwhile.`,
    "signin-ask": "Mail sign-in is paused: Exchange did not accept the login and password. Enter the password again in Settings, or press Try once more there.",
    "auth-refused": "Exchange did not accept the login and password.",
    "auth-negotiate": "Exchange did not accept the automatic sign-in. It works on a domain computer signed in with the work account; otherwise sign in with a password.",
    unreachable: (detail: string) => `Exchange is not reachable from this machine. Check the corporate network or VPN.${curlSaid(detail)}`,
    "broke-off": (detail: string) => `The connection to Exchange broke off. Check the corporate network or VPN and try again.${curlSaid(detail)}`,
    timeout: "Exchange did not answer in time. Check the corporate network or VPN.",
    tls: (detail: string) => `The secure connection to Exchange failed. If it repeats, show this message to IT.${curlSaid(detail)}`,
    "curl-missing": (path: string) => `bb reaches Exchange through curl, and curl did not start on this machine${path ? ` (${path})` : ""}.`,
    "ews-forbidden": "Exchange refused this account access to Exchange Web Services (HTTP 403).",
    "ews-not-found": "There is no Exchange Web Services at this address (HTTP 404). Check the address.",
    "ews-redirect": "Exchange redirected the request. Check the address: it should end with /EWS/Exchange.asmx.",
    "item-gone": "The message is not in the mailbox any more.",
    "no-machine": "This thread has no machine to reach Exchange from.",
  },
  {
    "not-connected": "Почта на этой машине ещё не подключена. Подключите её в настройках на этой странице.",
    "password-missing": "Пароля от почты на этой машине нет. Введите его снова в настройках на этой странице.",
    "password-required": "Введите пароль.",
    "password-other-account": "Сохранённый пароль был от прежнего адреса или логина, и bb его удалил. Введите пароль для нового.",
    "login-required": "Введите логин, например DOMAIN\\name или name@company.com.",
    "bad-address": "Введите адрес Exchange, например https://mail.example.com/EWS/Exchange.asmx.",
    "https-required": "Адрес Exchange должен начинаться с https://.",
    "login-in-address": "Не пишите логин в адресе: для него есть своё поле.",
    "signin-paused": (at) =>
      `Вход в почту на паузе: Exchange не принял логин и пароль. Чтобы домен не заблокировал учётную запись, bb попробует снова не раньше ${clock("ru", at)}, кто бы ни просил. Пока проверьте пароль в настройках.`,
    "signin-ask": "Вход в почту на паузе: Exchange не принял логин и пароль. Введите пароль снова в настройках или нажмите там «Попробовать ещё раз».",
    "auth-refused": "Exchange не принял логин и пароль.",
    "auth-negotiate": "Exchange не принял автоматический вход. Он работает на доменном компьютере под рабочей учётной записью, в остальных случаях входите по паролю.",
    unreachable: (detail) => `С этой машины Exchange недоступен. Проверьте корпоративную сеть или VPN.${curlSaid(detail)}`,
    "broke-off": (detail) => `Соединение с Exchange оборвалось. Проверьте корпоративную сеть или VPN и попробуйте ещё раз.${curlSaid(detail)}`,
    timeout: "Exchange не ответил вовремя. Проверьте корпоративную сеть или VPN.",
    tls: (detail) => `Не удалось установить защищённое соединение с Exchange. Если повторится, покажите это сообщение IT.${curlSaid(detail)}`,
    "curl-missing": (path) => `bb подключается к Exchange через curl, а curl на этой машине не запустился${path ? ` (${path})` : ""}.`,
    "ews-forbidden": "Exchange закрыл этой учётной записи доступ к Exchange Web Services (HTTP 403).",
    "ews-not-found": "По этому адресу нет Exchange Web Services (HTTP 404). Проверьте адрес.",
    "ews-redirect": "Exchange перенаправил запрос. Проверьте адрес: он должен заканчиваться на /EWS/Exchange.asmx.",
    "item-gone": "Этого письма в ящике уже нет.",
    "no-machine": "У этого треда нет машины, с которой можно достучаться до Exchange.",
  },
);

type HostErrorTexts = (typeof hostErrors)["en"];

const TAG = /\[mail:([a-z-]+)(?::([^\]\s]*))?\]\s*/;

/** The text to show for a failure message from the host or the server. */
export function explain(texts: HostErrorTexts, raw: string): string {
  const match = TAG.exec(raw);
  if (!match) return raw;
  const code = match[1]!;
  // An unknown code — a newer host than this panel — keeps the English text, without the tag.
  if (!Object.hasOwn(texts, code)) return raw.replace(TAG, "");
  const text = texts[code as keyof HostErrorTexts];
  if (typeof text === "string") return text;
  let param = "";
  try {
    param = decodeURIComponent(match[2] ?? "");
  } catch {
    // A broken param is left out, not shown half-decoded.
  }
  return text(param);
}

/** `explain` in the panel's current language: call it when rendering, so a language switch reaches stored errors too. */
export function useExplain(): (raw: string) => string {
  const texts = useMessages(hostErrors);
  return (raw) => explain(texts, raw);
}
