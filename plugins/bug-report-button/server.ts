// bb-plugin-bug-report-button — server entry. It declares the settings, hands the page what it shows, and sends the
// report: to a form as multipart/form-data, or to a tracker's REST API with the person's own key through the host entry
// on their machine. The page cannot post to another site itself.
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
import { DEFAULT_AUTH, readRestConfig, restTakesPictures, sendRest } from "./src/rest";
import { hostContract, keyStatusSchema, type KeyStatus } from "./contract";

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
      /** Pictures can be picked but do not go with the report: the page keeps them and points to the form. */
      picturesStay: z.boolean(),
      problem: z.string().nullable(),
      /** "form": multipart to a form address; "rest": JSON to a tracker's API with the person's key. */
      mode: z.enum(["form", "rest"]),
      /** REST: the person's key on their machine, null when it could not be checked. */
      key: keyStatusSchema.nullable(),
      keyHelp: z.string(),
      /** REST: why the key could not be checked, in words. */
      keyProblem: z.string().nullable(),
    }),
  },
  key_save: { input: z.object({ key: z.string().trim().min(1).max(8192) }).strict(), output: keyStatusSchema },
  key_forget: { input: z.null(), output: keyStatusSchema },
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
      z.object({ ok: z.literal(true), key: z.string().nullable(), url: z.string().nullable(), warning: z.string().nullable() }),
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
    sendMode: {
      type: "string",
      label: "Send mode",
      description: '"form": multipart/form-data to the submit address. "rest": JSON to a tracker\'s API with the person\'s own API key, kept in their OS key store.',
      experimental_schema: z.enum(["form", "rest"]),
      default: "form",
    },
    apiBaseUrl: {
      type: "string",
      label: "API address (REST)",
      description: "The tracker's API address, such as https://tracker.example.com/api/v1. The key goes only there.",
      experimental_schema: z.string().refine((value) => value.trim() === "" || readFormUrl(value) !== "", "API address must be http or https"),
      default: "",
    },
    submitPath: {
      type: "string",
      label: "Submit path (REST)",
      description: "Path under the API address that takes the report as JSON, such as /forms/<form id>/submit. Fields come from Form fields.",
      experimental_schema: z.string().max(500).refine((value) => value.trim() === "" || value.trim().startsWith("/"), "The path must start with /"),
      default: "",
    },
    restFiles: {
      type: "string",
      label: "Pictures (REST)",
      description:
        '"form": the report and its pictures go in one multipart/form-data request to the submit path, pictures under Picture field (several are joined into one unless Several pictures is "separate"). "attach": the report goes as JSON, then each picture to Attachments path. "none": JSON only; the page keeps the pictures and asks the person to attach them in the form (Form address).',
      experimental_schema: z.enum(["form", "attach", "none"]),
      default: "attach",
    },
    attachPath: {
      type: "string",
      label: "Attachments path (REST)",
      description: "Path that takes one picture of a created record as multipart/form-data, with {key}, such as /issues/{key}/attachments. Empty: no pictures.",
      experimental_schema: z.string().max(500).refine((value) => value.trim() === "" || (value.trim().startsWith("/") && value.includes("{key}")), "The path must start with / and contain {key}"),
      default: "",
    },
    attachField: {
      type: "string",
      label: "Attachment field (REST)",
      description: 'Form field name of the picture in an attachment request. Default "file".',
      experimental_schema: z.string().max(100),
      default: "file",
    },
    authHeader: {
      type: "string",
      label: "API key header (REST)",
      description: `Header that carries the key. Default "${DEFAULT_AUTH.header}".`,
      experimental_schema: z.string().max(64),
      default: DEFAULT_AUTH.header,
    },
    authFormat: {
      type: "string",
      label: "API key format (REST)",
      description: 'Header value with {key}, such as "Bearer {key}". Default "{key}".',
      experimental_schema: z.string().max(200),
      default: DEFAULT_AUTH.format,
    },
    shareKeyWith: {
      type: "string",
      label: "Use the key of plugin (REST)",
      description: 'Another plugin on the same machine whose key for the same API address is used when this one has none, such as "tracker-board". Empty: only the key saved here.',
      experimental_schema: z.string().max(60),
      default: "",
    },
    keyHelp: {
      type: "string",
      label: "Where to get a key (REST)",
      description: "One line shown next to the key field.",
      experimental_schema: z.string().max(300),
      default: "",
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  /** The person's machine: bb's primary one, else the first connected. */
  async function machine(): Promise<string> {
    const hosts = (await bb.sdk.hosts.list()).filter((candidate) => candidate.lifecycle.phase !== "destroyed");
    const { primaryHostId } = await bb.sdk.system.config();
    const id = primaryHostId ?? hosts.find((candidate) => candidate.status === "connected")?.id ?? hosts[0]?.id;
    if (!id) throw new Error("There is no computer connected to bb to keep the key.");
    return id;
  }
  async function restOrThrow() {
    const config = readRestConfig(await settings.get());
    if ("error" in config) throw new Error(config.error === "not-configured" ? "Sending through the API is not set up." : config.error);
    return config;
  }

  bb.rpc.register(rpcContract, {
    config: async () => {
      const values = await settings.get();
      const { url, label } = readConfig(values);
      if (values.sendMode === "rest") {
        const rest = readRestConfig(values);
        const canSend = !("error" in rest);
        let key: KeyStatus | null = null;
        let keyProblem: string | null = null;
        if (canSend) {
          try {
            key = await host.call("status", { baseUrl: rest.baseUrl, shareWith: rest.shareWith }, { hostId: await machine(), timeoutMs: 30_000 });
          } catch (error) {
            keyProblem = `Could not check the API key on this computer: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        return {
          label,
          formUrl: url,
          canSend,
          canAttach: canSend && (restTakesPictures(rest) || rest.files === "none"),
          combine: canSend && rest.files === "form" && rest.combine,
          picturesStay: canSend && rest.files === "none",
          problem: "error" in rest && rest.error !== "not-configured" ? rest.error : null,
          mode: "rest" as const,
          key,
          keyHelp: canSend ? rest.keyHelp : "",
          keyProblem,
        };
      }
      const send = readSendConfig(values);
      const problem = "error" in send && send.error !== "not-configured" ? send.error : null;
      const canSend = !("error" in send);
      return {
        label,
        formUrl: url,
        canSend,
        canAttach: canSend && send.fileField !== "",
        combine: canSend && send.fileMode === "combine",
        picturesStay: false,
        problem,
        mode: "form" as const,
        key: null,
        keyHelp: "",
        keyProblem: null,
      };
    },
    key_save: async ({ key }) => {
      const rest = await restOrThrow();
      return host.call("saveKey", { baseUrl: rest.baseUrl, shareWith: rest.shareWith, key }, { hostId: await machine(), timeoutMs: 60_000 });
    },
    key_forget: async () => {
      const rest = await restOrThrow();
      return host.call("forget", { baseUrl: rest.baseUrl, shareWith: rest.shareWith }, { hostId: await machine(), timeoutMs: 60_000 });
    },
    send: async ({ subject, description, client, images }) => {
      const values = await settings.get();
      const context = [`Bug Report Button ${VERSION}`.trim(), `${platform()} ${release()} ${arch()}`, client.trim()].filter(Boolean).join("\n");
      if (values.sendMode === "rest") {
        const rest = readRestConfig(values);
        if ("error" in rest) return { ok: false as const, error: rest.error === "not-configured" ? "Sending through the API is not set up." : rest.error };
        try {
          const hostId = await machine();
          const call = { hostId, timeoutMs: 90_000 };
          const result = await sendRest(rest, { subject: subject.trim(), description: description.trim(), context }, restTakesPictures(rest) ? images : [], {
            postForm: (input) => host.call("postForm", input, call),
            postJson: (input) => host.call("postJson", input, call),
            postFile: (input) => host.call("postFile", input, call),
          });
          if (!result.ok) bb.log.warn(`bug report not sent: ${result.error}`);
          else if (result.warning) bb.log.warn(`bug report sent with a warning: ${result.warning}`);
          return result;
        } catch (error) {
          return { ok: false as const, error: `The report was not sent: ${error instanceof Error ? error.message : String(error)}.` };
        }
      }
      const config = readSendConfig(values);
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
      const result = await sendReport(config, { subject: subject.trim(), description: description.trim(), context, files: config.fileField ? files : [] });
      if (!result.ok) bb.log.warn(`bug report not sent: ${result.error}`);
      return result.ok ? { ...result, warning: null } : result;
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
