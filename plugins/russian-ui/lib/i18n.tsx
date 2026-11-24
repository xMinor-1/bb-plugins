// Interface language for the plugins of this repository: English or Russian.
//
// Canonical copy: shared/i18n.tsx in the xMinor-1/bb-plugins repository. Each
// plugin keeps an identical copy (plugins are built and installed one by one,
// so they cannot import from outside their own directory). Change it there and
// copy it to every plugin again.
//
// bb loads plugin frontends into its own page, so they share localStorage: the
// language picked in one plugin's panel switches every plugin at once. Until
// someone picks, the browser's language decides.
//
// Frontend only: server code must not import this file (it uses React and the
// browser). A server that writes text for the panel takes `lang` in the RPC input.
import { useSyncExternalStore } from "react";

export type Lang = "en" | "ru";
export const LANGS: readonly Lang[] = ["en", "ru"];

const STORAGE_KEY = "xminor-plugins.lang";
const CHANGE_EVENT = "xminor-plugins:lang-change";

function storedLang(): Lang | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "en" || value === "ru" ? value : null;
  } catch {
    return null;
  }
}

/** The browser's first preferred language, if it is Russian; English otherwise. */
export function browserLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  const first = navigator.languages?.[0] ?? navigator.language ?? "";
  return first.toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** The current language, for code outside React components. */
export function getLang(): Lang {
  return storedLang() ?? browserLang();
}

/** Picks a language for every plugin of this repository; `null` returns to the browser's language. */
export function setLang(lang: Lang | null): void {
  try {
    if (lang) localStorage.setItem(STORAGE_KEY, lang);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is unavailable: the choice lasts until the page reloads.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  window.addEventListener("languagechange", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("languagechange", onChange);
  };
}

/** The current language; the component re-renders when it changes in any plugin or tab. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "en");
}

type Message = string | ((...args: never[]) => string);
type Translation<M> = { [K in keyof M]: M[K] extends (...args: infer A) => string ? (...args: A) => string : string };

/**
 * A plugin's texts in both languages. TypeScript requires the same keys, and
 * the same arguments for texts that are functions, in the Russian half.
 *
 *   const messages = defineMessages(
 *     { save: "Save", apps: (n: number) => `${n} ${n === 1 ? "app" : "apps"}` },
 *     { save: "Сохранить", apps: (n) => `${n} ${pluralRu(n, ["приложение", "приложения", "приложений"])}` },
 *   );
 *   const t = useMessages(messages);   // in a component
 *   t.save; t.apps(3);
 */
export function defineMessages<M extends Record<string, Message>>(en: M, ru: Translation<M>): Record<Lang, M> {
  return { en, ru: ru as unknown as M };
}

/** Texts in the current language for a component. */
export function useMessages<M>(messages: Record<Lang, M>): M {
  return messages[useLang()];
}

/** Texts in the current language for code outside components (toasts, clipboard text, commands). */
export function messagesNow<M>(messages: Record<Lang, M>): M {
  return messages[getLang()];
}

/** Russian plural form: pluralRu(n, ["день", "дня", "дней"]); fractions take the second form (1,5 дня). */
export function pluralRu(n: number, [one, few, many]: readonly [string, string, string]): string {
  if (!Number.isInteger(n)) return few;
  const abs = Math.abs(n);
  const lastTwo = abs % 100;
  const last = abs % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** BCP 47 locale for Intl formatting of numbers and dates. */
export function intlLocale(lang: Lang): string {
  return lang === "ru" ? "ru-RU" : "en-US";
}

/** The EN | RU switch for a plugin's panel header or settings. */
export function LanguageSwitch({ className }: { className?: string }) {
  const lang = useLang();
  return (
    <div
      role="group"
      aria-label={lang === "ru" ? "Язык интерфейса" : "Interface language"}
      className={`inline-flex shrink-0 rounded-md border border-border p-0.5 text-xs ${className ?? ""}`}
    >
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          aria-pressed={lang === code}
          onClick={() => setLang(code)}
          className={`rounded px-2 py-0.5 ${lang === code ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
