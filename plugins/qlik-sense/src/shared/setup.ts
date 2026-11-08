// The onboarding step: whether Qlik Sense is set up on a machine, for a build's
// setup page (Fleet Kit asks through `bb.sdk.plugins.callRpc`). The shape is
// shared by every plugin in this repository that has a setup step:
//   input  { lang?: "en" | "ru", hostId?: string }
//   output { state: "done" | "todo" | "problem", summary: string, path?: string }
// Done means both halves of the setup: the sign-in passed its last check and at
// least one report is enabled for agents. The answer comes from the saved state
// only: no Qlik request, no password, no report names, no address or login.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ConnectionStatus } from "../../contract";

export const setupLangSchema = z.enum(["en", "ru"]);
export type SetupLang = z.infer<typeof setupLangSchema>;
export const setupStateSchema = z.enum(["done", "todo", "problem"]);
export type SetupState = z.infer<typeof setupStateSchema>;

const setupInput = z.object({ lang: setupLangSchema.optional(), hostId: z.string().min(1).max(200).optional() }).strict();
const setupOutput = z
  .object({
    state: setupStateSchema,
    summary: z.string().max(200),
    path: z.string().regex(/^\/plugins\//).optional(),
  })
  .strict();

export const setupStatusContract = defineRpcContract({
  setupStatus: {
    experimental_description:
      "Whether Qlik Sense is set up on a machine: done, todo or problem, with one line for a person. Reads the saved state only.",
    input: setupInput,
    output: setupOutput,
  },
});

/**
 * Sign-in handed over by a trusted plugin (a build's control panel asks for the
 * company account once and passes it on). Only plugins listed in the
 * `accountPlugins` setting may call it. The answer is the setup step after the
 * check; `rejected` is set only when Qlik refused the login or password, so the
 * caller does not send them again and lock the account. The answer never holds
 * the login or the password.
 */
export const accountSignInContract = defineRpcContract({
  accountSignIn: {
    experimental_description:
      "Save the company account from a trusted plugin and check the sign-in. Answers like setupStatus, plus `rejected` when Qlik refused the login or password.",
    input: z
      .object({
        user: z.string().min(1).max(256),
        password: z.string().min(1).max(1024),
        lang: setupLangSchema.optional(),
        hostId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    output: setupOutput.extend({ rejected: z.boolean().optional() }).strict(),
  },
});

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Plugin ids separated by commas, spaces or lines. Throws on anything that is not an id. */
export function parsePluginList(text: string): string[] {
  const ids = text
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) if (!PLUGIN_ID.test(id)) throw new Error(`"${id}" is not a plugin id`);
  return [...new Set(ids)];
}

/** Qlik's form sign-in wants `DOMAIN\\user` (the host's checkLogin enforces the same). */
export const hasDomain = (user: string) => user.trim().includes("\\");

/** Where a person sets Qlik up: the plugin's own page in the bb sidebar. */
export const SETUP_PATH = "/plugins/qlik-sense/qlik-sense";

const TEXT = {
  en: {
    done: (apps: number) => `Signed in; reports for agents: ${apps}`,
    notConnected: "Qlik is not connected yet",
    noPassword: "Enter the Qlik password",
    notChecked: "Saved but the sign-in is not checked yet",
    refused: "Sign-in stopped: Qlik did not accept the password",
    failed: "The last sign-in check failed, see the Qlik page",
    noReports: "Signed in; now pick the reports agents may read",
    offline: "The machine with Qlik is not reachable",
    unreadable: "The plugin could not read its state on that machine",
    noMachine: "No machine is connected to bb",
    noAddress: "The Qlik Sense address is not set in the plugin settings",
    badLogin: "The login needs a domain: DOMAIN\\user",
    tooLong: "The login or password is too long for Qlik Sense",
    notSaved: "The plugin could not save the sign-in on that machine",
  },
  ru: {
    done: (apps: number) => `Вход есть, отчётов для агентов: ${apps}`,
    notConnected: "Qlik ещё не подключён",
    noPassword: "Введите пароль от Qlik",
    notChecked: "Сохранено, но вход ещё не проверен",
    refused: "Вход остановлен: Qlik не принял пароль",
    failed: "Последняя проверка входа не прошла, подробности на странице Qlik",
    noReports: "Вход есть, теперь выберите отчёты для агентов",
    offline: "Машина с Qlik не на связи",
    unreadable: "Плагин не смог прочитать своё состояние на этой машине",
    noMachine: "К bb не подключена ни одна машина",
    noAddress: "В настройках плагина не задан адрес Qlik Sense",
    badLogin: "Логин нужен с доменом: DOMAIN\\user",
    tooLong: "Логин или пароль слишком длинный для Qlik Sense",
    notSaved: "Плагин не смог сохранить вход на этой машине",
  },
} satisfies Record<SetupLang, Record<string, string | ((apps: number) => string)>>;

export type SetupText = Exclude<keyof (typeof TEXT)["en"], "done">;
export type SetupStep = { state: SetupState; summary: string; path: string };

export function setupStep(state: SetupState, text: SetupText, lang: SetupLang = "en"): SetupStep {
  return { state, summary: TEXT[lang][text], path: SETUP_PATH };
}

/** The step from the host's connection status. */
export function setupFromStatus(status: ConnectionStatus, lang: SetupLang = "en"): SetupStep {
  if (!status.url) return setupStep("todo", "notConnected", lang);
  if (!status.hasPassword) return setupStep("todo", "noPassword", lang);
  if (status.blocked) return setupStep("problem", "refused", lang);
  if (!status.lastCheck) return setupStep("todo", "notChecked", lang);
  if (!status.lastCheck.ok) return setupStep("problem", "failed", lang);
  if (status.catalogApps === 0) return setupStep("todo", "noReports", lang);
  return { state: "done", summary: TEXT[lang].done(status.catalogApps), path: SETUP_PATH };
}
