// The onboarding step: whether mail is set up on a machine, for a build's setup
// page (Fleet Kit asks through `bb.sdk.plugins.callRpc`). The shape is shared by
// every plugin in this repository that has a setup step:
//   input  { lang?: "en" | "ru", hostId?: string }
//   output { state: "done" | "todo" | "problem", summary: string, path?: string }
// The answer comes from the saved connection and the last check: no Exchange
// request, no password, no mail. The summary names no address and no login,
// because another plugin reads it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { langSchema, type ConnectionStatus, type Lang } from "../../contract";

export const setupStateSchema = z.enum(["done", "todo", "problem"]);
export type SetupState = z.infer<typeof setupStateSchema>;

export const setupStatusContract = defineRpcContract({
  setupStatus: {
    experimental_description:
      "Whether Exchange Mail is set up on a machine: done, todo or problem, with one line for a person. Reads the saved connection only.",
    input: z.object({ lang: langSchema.optional(), hostId: z.string().min(1).max(200).optional() }).strict(),
    output: z
      .object({
        state: setupStateSchema,
        summary: z.string().max(200),
        path: z.string().regex(/^\/plugins\//).optional(),
      })
      .strict(),
  },
});

/** Where a person sets mail up: the plugin's own page in the bb sidebar. */
export const SETUP_PATH = "/plugins/exchange-mail/mail";

const TEXT = {
  en: {
    done: "Mail is connected",
    notConnected: "Mail is not connected yet",
    noPassword: "Enter the mail password",
    notChecked: "Saved but not checked yet",
    paused: "Sign-in is paused: Exchange did not accept the password",
    failed: "The last check failed, see the Mail page",
    noCurl: "curl did not start on this machine",
    offline: "The machine with mail is not reachable",
    unreadable: "The plugin could not read its state on that machine",
    noMachine: "No machine is connected to bb",
  },
  ru: {
    done: "Почта подключена",
    notConnected: "Почта ещё не подключена",
    noPassword: "Введите пароль от почты",
    notChecked: "Сохранено, но ещё не проверено",
    paused: "Вход на паузе: Exchange не принял пароль",
    failed: "Последняя проверка не прошла, подробности на странице почты",
    noCurl: "На этой машине не запустился curl",
    offline: "Машина с почтой не на связи",
    unreadable: "Плагин не смог прочитать своё состояние на этой машине",
    noMachine: "К bb не подключена ни одна машина",
  },
} satisfies Record<Lang, Record<string, string>>;

export type SetupText = keyof (typeof TEXT)["en"];
export type SetupStep = { state: SetupState; summary: string; path: string };

export function setupStep(state: SetupState, text: SetupText, lang: Lang = "en"): SetupStep {
  return { state, summary: TEXT[lang][text], path: SETUP_PATH };
}

/** The step from the host's connection status. */
export function setupFromStatus(status: ConnectionStatus, lang: Lang = "en"): SetupStep {
  if (!status.url) return setupStep("todo", "notConnected", lang);
  if (status.curlError) return setupStep("problem", "noCurl", lang);
  if (status.auth === "password" && !status.hasPassword) return setupStep("todo", "noPassword", lang);
  if (status.blocked) return setupStep("problem", "paused", lang);
  if (!status.lastCheck) return setupStep("todo", "notChecked", lang);
  if (!status.lastCheck.ok) return setupStep("problem", "failed", lang);
  return setupStep("done", "done", lang);
}
