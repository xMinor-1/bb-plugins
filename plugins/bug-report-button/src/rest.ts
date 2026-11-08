// The REST mode: the report goes to a tracker's API with the person's own API key. Pictures go either in the same
// request, as a file field of the form (multipart/form-data), or one by one as attachments of the created record. The key stays on the person's machine (the host entry); this module only builds the
// requests from the settings and reads the answers.
import type { Answer, Auth, FailureCode } from "../contract";
import { readFormUrl } from "./config";
import type { ImageType } from "./report";
import { fillTemplate, readAnswer, readFields } from "./send";

export const DEFAULT_AUTH: Auth = { header: "X-API-Key", format: "{key}" };
const FIELD_KEY = /^[A-Za-z0-9_.\-[\]]{1,100}$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;

export type RestConfig = {
  baseUrl: string;
  submitPath: string;
  fields: Record<string, string>;
  auth: Auth;
  /** Path of a record's attachments with {key}. Empty: pictures are not sent. */
  attachPath: string;
  attachField: string;
  shareWith: string | null;
  recordUrl: string;
  keyHelp: string;
  /** "form": the report and its pictures in one multipart request; "attach": JSON, then each picture on the record. */
  files: "form" | "attach";
  /** "form": the form's file field. */
  fileField: string;
  /** "form": several pictures are joined into one, for a field that takes one file. */
  combine: boolean;
};

function readPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim();
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && path.length <= 500 ? path : "";
}

export function readRestConfig(values: Record<string, unknown>): RestConfig | { error: string } {
  const baseUrl = readFormUrl(values.apiBaseUrl).replace(/\/+$/, "");
  const submitPath = readPath(values.submitPath);
  if (!baseUrl || !submitPath) return { error: "not-configured" };
  const fields = readFields(values.submitFields);
  if (!fields) return { error: "The form fields setting is not a JSON object of field names and templates." };
  const header = typeof values.authHeader === "string" && values.authHeader.trim() ? values.authHeader.trim() : DEFAULT_AUTH.header;
  const format = typeof values.authFormat === "string" && values.authFormat.trim() ? values.authFormat.trim() : DEFAULT_AUTH.format;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header) || format.split("{key}").length !== 2) return { error: "The API key header settings are not valid." };
  const attachPath = readPath(values.attachPath);
  if (values.attachPath && !attachPath) return { error: "The attachments path must start with /." };
  if (attachPath && !attachPath.includes("{key}")) return { error: "The attachments path must contain {key}." };
  const attachField = typeof values.attachField === "string" && values.attachField.trim() ? values.attachField.trim() : "file";
  if (!FIELD_KEY.test(attachField)) return { error: "The attachment field name has characters a form field cannot have." };
  const share = typeof values.shareKeyWith === "string" ? values.shareKeyWith.trim() : "";
  const recordUrl = typeof values.recordUrl === "string" && values.recordUrl.includes("{key}") ? values.recordUrl.trim() : "";
  const keyHelp = typeof values.keyHelp === "string" ? values.keyHelp.trim().slice(0, 300) : "";
  const files = values.restFiles === "form" ? "form" : "attach";
  const fileField = typeof values.fileField === "string" ? values.fileField.trim() : "file";
  if (fileField && !FIELD_KEY.test(fileField)) return { error: "The picture field name setting has characters a form field cannot have." };
  return {
    baseUrl,
    submitPath,
    fields,
    auth: { header, format },
    attachPath,
    attachField,
    shareWith: PLUGIN_ID.test(share) ? share : null,
    recordUrl,
    keyHelp,
    files,
    fileField,
    combine: values.fileMode !== "separate",
  };
}

/** Pictures go with the report at all: the form has a file field, or the record takes attachments. */
export function restTakesPictures(config: RestConfig): boolean {
  return config.files === "form" ? config.fileField !== "" : config.attachPath !== "";
}

export function filledFields(fields: Record<string, string>, report: { subject: string; description: string; context: string }): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).map(([key, template]) => [key, fillTemplate(template, report)]));
}

/** The JSON body: each field's template filled in. */
export function buildJson(fields: Record<string, string>, report: { subject: string; description: string; context: string }): string {
  return JSON.stringify(filledFields(fields, report));
}

export function attachPathFor(config: RestConfig, key: string): string {
  return config.attachPath.replaceAll("{key}", encodeURIComponent(key));
}

const SENTENCES: Record<FailureCode, string> = {
  unauthorized: "The tracker did not accept your API key. Check it or save a new one",
  forbidden: "Your API key has no right to do this in the tracker",
  notFound: "The tracker has no such form or record. The plugin settings may be out of date",
  tooLarge: "The tracker refused the request as too large. Attach smaller pictures",
  badRequest: "The tracker refused the report",
  redirect: "The tracker answered with a redirect. It is not followed, so the key does not go to another address",
  serverError: "The tracker's server failed",
  unreachable: "Could not reach the tracker. Check the network or VPN",
  timeout: "The tracker did not answer in a minute. Check the network or VPN",
  noKey: "There is no API key on this computer. Save yours above",
  storeError: "Could not read the API key from this computer's key store",
  badAddress: "The tracker address or path in the plugin settings is not valid",
};

export function failureText(answer: Extract<Answer, { ok: false }>): string {
  const status = answer.status ? ` (HTTP ${answer.status})` : "";
  return `${SENTENCES[answer.code]}${status}${answer.detail ? `: ${answer.detail}` : "."}`;
}


type RestImage = { name: string; type: ImageType; base64: string };
export type RestCalls = {
  postForm: (input: {
    baseUrl: string;
    shareWith: string | null;
    auth: Auth;
    path: string;
    fields: Record<string, string>;
    field: string;
    files: RestImage[];
  }) => Promise<Answer>;
  postJson: (input: { baseUrl: string; shareWith: string | null; auth: Auth; path: string; body: string }) => Promise<Answer>;
  postFile: (input: {
    baseUrl: string;
    shareWith: string | null;
    auth: Auth;
    path: string;
    field: string;
    file: { name: string; type: ImageType; base64: string };
  }) => Promise<Answer>;
};
export type RestResult = { ok: true; key: string | null; url: string | null; warning: string | null } | { ok: false; error: string };

/** Sends the report, then attaches each picture to the record it created. A picture that fails does not undo the report. */
export async function sendRest(
  config: RestConfig,
  report: { subject: string; description: string; context: string },
  images: ReadonlyArray<{ name: string; type: ImageType; base64: string }>,
  calls: RestCalls,
): Promise<RestResult> {
  const target = { baseUrl: config.baseUrl, shareWith: config.shareWith, auth: config.auth };
  if (config.files === "form") {
    const sent = await calls.postForm({
      ...target,
      path: config.submitPath,
      fields: filledFields(config.fields, report),
      field: config.fileField,
      files: config.fileField ? [...images] : [],
    });
    if (!sent.ok) return { ok: false, error: failureText(sent) };
    return { ok: true, ...readAnswer(sent.text, config.recordUrl), warning: null };
  }
  const answer = await calls.postJson({ ...target, path: config.submitPath, body: buildJson(config.fields, report) });
  if (!answer.ok) return { ok: false, error: failureText(answer) };
  const { key, url } = readAnswer(answer.text, config.recordUrl);
  if (!images.length || !config.attachPath) return { ok: true, key, url, warning: null };
  if (!key) {
    return { ok: true, key, url, warning: "The report is sent, but the pictures are not: the tracker did not say which record it created." };
  }
  const failed: string[] = [];
  for (const image of images) {
    const attached = await calls.postFile({ ...target, path: attachPathFor(config, key), field: config.attachField, file: image });
    if (!attached.ok) failed.push(`${image.name}: ${failureText(attached)}`);
  }
  const warning = failed.length
    ? `The report is sent, but ${failed.length === images.length ? "the pictures are" : `${failed.length} of ${images.length} pictures are`} not attached. ${failed.join(" ")}`
    : null;
  return { ok: true, key, url, warning };
}
