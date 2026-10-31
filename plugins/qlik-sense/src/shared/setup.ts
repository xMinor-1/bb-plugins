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

export const setupStatusContract = defineRpcContract({
  setupStatus: {
    experimental_description:
      "Whether Qlik Sense is set up on a machine: done, todo or problem, with one line for a person. Reads the saved state only.",
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
    noMachine: "No machine is connected to bb",
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
    noMachine: "К bb не подключена ни одна машина",
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
