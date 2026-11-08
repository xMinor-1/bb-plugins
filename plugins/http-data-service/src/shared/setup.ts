// The onboarding step: whether a person signed in on a machine, for a build's
// setup page (Fleet Kit asks through `bb.sdk.plugins.callRpc`). The answer comes
// from the saved state only: no service request, no password, address or login.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ConnectionStatus } from "../../contract";

export const setupLangSchema = z.enum(["en", "ru"]);
export type SetupLang = z.infer<typeof setupLangSchema>;
export const setupStateSchema = z.enum(["done", "todo", "problem"]);
export type SetupState = z.infer<typeof setupStateSchema>;

export const setupStatusContract = defineRpcContract({
  setupStatus: {
    experimental_description: "Whether the person signed in to the data service on a machine: done, todo or problem, with one line for a person. Reads the saved state only.",
    input: z.object({ lang: setupLangSchema.optional(), hostId: z.string().min(1).max(200).optional() }).strict(),
    output: z
      .object({
        state: setupStateSchema,
        summary: z.string().max(200),
        path: z.string().regex(/^\/plugins\//).optional(),
      })
      .strict(),
  },
});

/** Where a person signs in: the plugin's own page in the bb sidebar. */
export const SETUP_PATH = "/plugins/http-data-service/data-service";

const TEXT = {
  en: {
    done: "Signed in",
    notSignedIn: "Sign in with your login and password",
    noPassword: "Enter your password",
    notChecked: "Saved but the sign-in is not checked yet",
    paused: "Sign-in is paused: the service did not accept the password",
    failed: "The last check failed, see the sign-in page",
    addressChanged: "The service address changed: sign in again",
    notConfigured: "This build does not set the service address yet",
    offline: "The machine is not reachable",
    unreadable: "The plugin could not read its state on that machine",
    noMachine: "No machine is connected to bb",
    configProblem: "This build's service settings need a fix",
    badLogin: "The login must not be empty or contain a colon",
    badPassword: "The password is too long",
    saveFailed: "The sign-in could not be saved on that machine",
  },
  ru: {
    done: "Вход выполнен",
    notSignedIn: "Войдите своим логином и паролем",
    noPassword: "Введите пароль",
    notChecked: "Сохранено, но вход ещё не проверен",
    paused: "Вход на паузе: сервис не принял пароль",
    failed: "Последняя проверка не прошла, подробности на странице входа",
    addressChanged: "Адрес сервиса изменился: войдите заново",
    notConfigured: "В сборке ещё не задан адрес сервиса",
    offline: "Машина не на связи",
    unreadable: "Плагин не смог прочитать своё состояние на этой машине",
    noMachine: "К bb не подключена ни одна машина",
    configProblem: "Настройки сервиса в сборке нужно исправить",
    badLogin: "Логин не должен быть пустым или содержать двоеточие",
    badPassword: "Пароль слишком длинный",
    saveFailed: "Не удалось сохранить вход на этой машине",
  },
} satisfies Record<SetupLang, Record<string, string>>;

export type SetupText = keyof (typeof TEXT)["en"];
export type SetupStep = { state: SetupState; summary: string; path: string };

export function setupStep(state: SetupState, text: SetupText, lang: SetupLang = "en"): SetupStep {
  return { state, summary: TEXT[lang][text], path: SETUP_PATH };
}

/** The step from the host's connection status. */
export function setupFromStatus(status: ConnectionStatus, lang: SetupLang = "en"): SetupStep {
  if (!status.user) return setupStep("todo", "notSignedIn", lang);
  if (!status.hasPassword) return setupStep("todo", "noPassword", lang);
  if (status.addressChanged) return setupStep("todo", "addressChanged", lang);
  if (status.blocked) return setupStep("problem", "paused", lang);
  if (!status.lastCheck) return setupStep("todo", "notChecked", lang);
  if (!status.lastCheck.ok) return setupStep("problem", "failed", lang);
  return setupStep("done", "done", lang);
}
