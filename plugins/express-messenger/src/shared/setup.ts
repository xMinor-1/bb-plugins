// The onboarding step: whether the person has signed in to the messenger on a machine, for a
// build's setup page (Fleet Kit asks through `bb.sdk.plugins.callRpc`). The shape is shared by
// every plugin in this repository that has a setup step:
//   input  { lang?: "en" | "ru", hostId?: string }
//   output { state: "done" | "todo" | "problem", summary: string, path?: string }
// The answer comes from what the host remembers: no browser starts and the messenger is not
// asked. The summary names no chat and no person, because another plugin reads it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { langSchema, type Lang, type Status } from "../../contract";

export const setupStateSchema = z.enum(["done", "todo", "problem"]);
export type SetupState = z.infer<typeof setupStateSchema>;

export const setupStatusContract = defineRpcContract({
  setupStatus: {
    experimental_description: "Whether the person has signed in to the messenger on a machine: done, todo or problem, with one line for a person. Reads what the host remembers only.",
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

/** Where a person signs in: the plugin's own page in the bb sidebar. */
export const SETUP_PATH = "/plugins/express-messenger/messenger";

const TEXT = {
  en: {
    done: "Signed in to the messenger",
    notSignedIn: "Sign in to the messenger",
    signedOut: "The messenger asks to sign in again",
    noBrowser: "No Chromium-based browser on this machine: install Google Chrome or Microsoft Edge",
    notConfigured: "This build does not set the messenger address yet",
    offline: "The machine is not reachable",
    unreadable: "The plugin could not read its state on that machine",
    noMachine: "No machine is connected to bb",
  },
  ru: {
    done: "Вход в мессенджер выполнен",
    notSignedIn: "Войдите в мессенджер",
    signedOut: "Мессенджер просит войти заново",
    noBrowser: "На этой машине нет браузера на Chromium: поставьте Google Chrome или Microsoft Edge",
    notConfigured: "В этой сборке ещё не задан адрес мессенджера",
    offline: "Машина не на связи",
    unreadable: "Плагин не смог прочитать своё состояние на этой машине",
    noMachine: "К bb не подключена ни одна машина",
  },
} satisfies Record<Lang, Record<string, string>>;

export type SetupText = keyof (typeof TEXT)["en"];
export type SetupStep = { state: SetupState; summary: string; path: string };

export function setupStep(state: SetupState, text: SetupText, lang: Lang = "en"): SetupStep {
  return { state, summary: TEXT[lang][text], path: SETUP_PATH };
}

/** The step from the host's status: done only once the client has loaded signed in, whatever files are left from before. */
export function setupFromStatus(status: Status, lang: Lang = "en"): SetupStep {
  if (!status.browser) return setupStep("problem", "noBrowser", lang);
  if (status.signedIn === false) return setupStep("todo", "signedOut", lang);
  if (status.signedIn === true) return setupStep("done", "done", lang);
  return setupStep("todo", "notSignedIn", lang);
}
