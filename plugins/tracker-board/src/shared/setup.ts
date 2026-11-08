// The onboarding step: whether a person saved a working API key on a machine, for a
// build's setup page (Fleet Kit asks through `bb.sdk.plugins.callRpc`). The answer
// comes from the saved state only: no tracker request, no key, address or name.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { KeyStatus } from "../../contract";

export const setupLangSchema = z.enum(["en", "ru"]);
export type SetupLang = z.infer<typeof setupLangSchema>;
export const setupStateSchema = z.enum(["done", "todo", "problem"]);
export type SetupState = z.infer<typeof setupStateSchema>;

export const setupStatusContract = defineRpcContract({
  setupStatus: {
    experimental_description: "Whether the person saved a working tracker API key on a machine: done, todo or problem, with one line for a person. Reads the saved state only.",
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

/** Where a person enters the key: the board page, its settings open from the title bar. */
export const SETUP_PATH = "/plugins/tracker-board/board";

const TEXT = {
  en: {
    done: "The API key works",
    noKey: "Enter your API key in the board's settings",
    notChecked: "The key is saved but not checked yet",
    failed: "The last check failed, see the board's settings",
    addressChanged: "The tracker address changed: enter the key again",
    notConfigured: "This build does not set up the tracker yet",
    offline: "The machine is not reachable",
    unreadable: "The plugin could not read its state on that machine",
    noMachine: "No machine is connected to bb",
  },
  ru: {
    done: "Ключ API работает",
    noKey: "Введите ключ API в настройках доски",
    notChecked: "Ключ сохранён, но ещё не проверен",
    failed: "Последняя проверка не прошла, подробности в настройках доски",
    addressChanged: "Адрес трекера изменился: введите ключ заново",
    notConfigured: "В сборке ещё не настроен трекер",
    offline: "Машина не на связи",
    unreadable: "Плагин не смог прочитать своё состояние на этой машине",
    noMachine: "К bb не подключена ни одна машина",
  },
} satisfies Record<SetupLang, Record<string, string>>;

export type SetupText = keyof (typeof TEXT)["en"];
export type SetupStep = { state: SetupState; summary: string; path: string };

export function setupStep(state: SetupState, text: SetupText, lang: SetupLang = "en"): SetupStep {
  return { state, summary: TEXT[lang][text], path: SETUP_PATH };
}

/** The step from the host's key status. */
export function setupFromStatus(status: KeyStatus, lang: SetupLang = "en"): SetupStep {
  if (!status.hasKey) return setupStep("todo", "noKey", lang);
  if (status.addressChanged) return setupStep("todo", "addressChanged", lang);
  if (!status.lastCheck) return setupStep("todo", "notChecked", lang);
  if (!status.lastCheck.ok) return setupStep("problem", "failed", lang);
  return setupStep("done", "done", lang);
}
