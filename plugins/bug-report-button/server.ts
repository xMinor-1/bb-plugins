// bb-plugin-bug-report-button — server entry. It declares the settings, hands the page what it shows, and sends the
// report to the form: the page cannot post to another site itself.
import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_LABEL_LENGTH, readConfig, readFormUrl } from "./src/config";
import {
  IMAGE_TYPES,
  MAX_DESCRIPTION_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_SUBJECT_LENGTH,
  MAX_TOTAL_BYTES,
  formatBytes,
} from "./src/report";
import { PANEL_ID, REVEALED_KEY, revealOnce } from "./src/reveal";
import { DEFAULT_FILE_FIELD, readFields, readSendConfig, sendReport } from "./src/send";

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
})();

// Base64 grows a picture by a third; the limit leaves room for that and nothing more.
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

const imageSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(IMAGE_TYPES),
  base64: z.string().min(1).max(MAX_BASE64_CHARS),
});

export const rpcContract = defineRpcContract({
  config: {
    input: z.null(),
    output: z.object({
      label: z.string(),
      formUrl: z.string(),
      /** The page can send by itself. False shows the link to the form instead. */
      canSend: z.boolean(),
      /** Pictures go with the report: the form has a picture field. */
      canAttach: z.boolean(),
      /** Several pictures become one before sending: the form takes one file. */
      combine: z.boolean(),
      problem: z.string().nullable(),
    }),
  },
  send: {
    input: z
      .object({
        subject: z.string().trim().min(1).max(MAX_SUBJECT_LENGTH),
        description: z.string().max(MAX_DESCRIPTION_LENGTH),
        /** Where the person is: the app's user agent and window size, filled in by the page. */
        client: z.string().max(500),
        images: z.array(imageSchema).max(MAX_IMAGES),
      })
      .strict(),
    output: z.union([
      z.object({ ok: z.literal(true), key: z.string().nullable(), url: z.string().nullable() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
});

export default function bugReportButton(bb: BbPluginApi) {
  const settings = bb.settings.define({
    formUrl: {
      type: "string",
      label: "Form address",
      description: "The http or https address of the form in a browser. The page links to it when it cannot send by itself.",
      experimental_schema: z.string().refine((value) => value.trim() === "" || readFormUrl(value) !== "", "Form address must be http or https"),
      default: "",
    },
    label: {
      type: "string",
      label: "Caption",
      description: "A heading on the report page, for example in the people's own language. Empty shows none.",
      experimental_schema: z.string().max(MAX_LABEL_LENGTH),
      default: "",
    },
    submitUrl: {
      type: "string",
      label: "Submit address",
      description: "Where the page posts a report as multipart/form-data. Empty: the page links to the form instead of sending.",
      experimental_schema: z.string().refine((value) => value.trim() === "" || readFormUrl(value) !== "", "Submit address must be http or https"),
      default: "",
    },
    submitFields: {
      type: "string",
      label: "Form fields",
      description:
        'JSON object: form field name → text, with {subject}, {description} and {context} (app version and system). Empty: {"subject":"{subject}","description":"{description}"}.',
      experimental_schema: z.string().refine((value) => readFields(value) !== null, "Form fields must be a JSON object of field names and texts"),
      default: "",
    },
    fileField: {
      type: "string",
      label: "Picture field",
      description: `Form field name for the pictures. Empty sends no pictures. Default "${DEFAULT_FILE_FIELD}".`,
      experimental_schema: z.string().max(100),
      default: DEFAULT_FILE_FIELD,
    },
    fileMode: {
      type: "string",
      label: "Several pictures",
      description: '"combine" joins them into one picture, for a form that takes one file; "separate" sends each as its own file.',
      experimental_schema: z.enum(["combine", "separate"]),
      default: "combine",
    },
    recordUrl: {
      type: "string",
      label: "Record address",
      description: "Address of a created record, with {key}, for forms that answer with a key such as ABC-12 and no link.",
      experimental_schema: z.string().max(500),
      default: "",
    },
  });

  bb.rpc.register(rpcContract, {
    config: async () => {
      const values = await settings.get();
      const { url, label } = readConfig(values);
      const send = readSendConfig(values);
      const problem = "error" in send && send.error !== "not-configured" ? send.error : null;
      const canSend = !("error" in send);
      return {
        label,
        formUrl: url,
        canSend,
        canAttach: canSend && send.fileField !== "",
        combine: canSend && send.fileMode === "combine",
        problem,
      };
    },
    send: async ({ subject, description, client, images }) => {
      const config = readSendConfig(await settings.get());
      if ("error" in config) {
        return { ok: false as const, error: config.error === "not-configured" ? "Sending is not set up: there is no submit address." : config.error };
      }
      const files = images.map((image) => ({ name: image.name, type: image.type, bytes: new Uint8Array(Buffer.from(image.base64, "base64")) }));
      if (files.some((file) => file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_IMAGE_BYTES)) {
        return { ok: false as const, error: `A picture can be up to ${formatBytes(MAX_IMAGE_BYTES)}.` };
      }
      if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_TOTAL_BYTES) {
        return { ok: false as const, error: `All pictures together can be up to ${formatBytes(MAX_TOTAL_BYTES)}.` };
      }
      const context = [`Bug Report Button ${VERSION}`.trim(), `${platform()} ${release()} ${arch()}`, client.trim()].filter(Boolean).join("\n");
      const result = await sendReport(config, { subject: subject.trim(), description: description.trim(), context, files: config.fileField ? files : [] });
      if (!result.ok) bb.log.warn(`bug report not sent: ${result.error}`);
      return result;
    },
  });

  // Not awaited: the plugin starts at once, and a failed try is repeated on the next start.
  void revealOnce({
    itemId: `${bb.pluginId}/${PANEL_ID}`,
    wasRevealed: async () => (await bb.storage.kv.get<boolean>(REVEALED_KEY)) === true,
    markRevealed: () => bb.storage.kv.set(REVEALED_KEY, true),
    readVisible: async () => {
      const { preferences } = await bb.sdk.system.uiPreferences.list();
      return preferences["sidebar.visiblePluginPanels"];
    },
    writeVisible: async (value, expectedRevision) => {
      await bb.sdk.system.uiPreferences.set({ key: "sidebar.visiblePluginPanels", value, expectedRevision });
    },
  }).then(
    (result) => bb.log.info(`sidebar item: ${result}`),
    (error: unknown) => bb.log.warn(`sidebar item not shown: ${error instanceof Error ? error.message : String(error)}`),
  );
}
