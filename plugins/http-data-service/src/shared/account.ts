// One sign-in for several plugins: a build's setup plugin (Fleet Kit) asks for the
// company login once and hands it to the plugins listed as sharing it. Only plugins
// named in the `accountPlugins` setting may call this; the answer is the setup step
// after the check, never the login or the password.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { setupLangSchema, setupStateSchema } from "./setup";

export const accountSignInContract = defineRpcContract({
  accountSignIn: {
    experimental_description:
      "Save the person's login and password on a machine and check them, for plugins listed in accountPlugins. Returns the setup step after the check; rejected is true when the service refused this login or password.",
    input: z
      .object({
        user: z.string().min(1).max(256),
        password: z.string().min(1).max(1024),
        lang: setupLangSchema.optional(),
        hostId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    output: z
      .object({
        state: setupStateSchema,
        summary: z.string().max(200),
        path: z.string().regex(/^\/plugins\//).optional(),
        rejected: z.boolean().optional(),
      })
      .strict(),
  },
});

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The accountPlugins setting: plugin ids separated by commas, spaces or lines. Throws on anything else. */
export function parsePluginList(text: string): string[] {
  const ids = text
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) if (!PLUGIN_ID.test(id)) throw new Error(`"${id}" is not a plugin id`);
  return [...new Set(ids)];
}
