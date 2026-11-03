// bb-plugin-bug-report-button — server entry. It declares the settings and hands them to the page, which does the work.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULT_LABEL, MAX_LABEL_LENGTH, readConfig, readFormUrl } from "./src/button";

export default function bugReportButton(bb: BbPluginApi) {
  const settings = bb.settings.define({
    formUrl: {
      type: "string",
      label: "Form address",
      description: "The http or https address the button opens. Empty hides the button.",
      experimental_schema: z.string().refine((value) => value.trim() === "" || readFormUrl(value) !== "", "Form address must be http or https"),
      default: "",
    },
    label: {
      type: "string",
      label: "Caption",
      description: `Tooltip and screen reader name of the button. Empty shows "${DEFAULT_LABEL}".`,
      experimental_schema: z.string().max(MAX_LABEL_LENGTH),
      default: "",
    },
  });
  bb.http.route("GET", "/config", async (context) => context.json(readConfig(await settings.get())));
}
