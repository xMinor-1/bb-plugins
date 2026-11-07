// Sends a report to the configured form endpoint from the plugin server: a page in the app cannot post to another
// site because of CORS, and the server runs on the person's own machine, so it reaches the same network they do.
import { readFormUrl } from "./config";

export const MAX_FIELDS = 20;
export const MAX_TEMPLATE_LENGTH = 2000;
export const MAX_KEY_LENGTH = 100;
const SEND_TIMEOUT_MS = 60_000;
const MAX_ANSWER_CHARS = 200_000;

export const DEFAULT_FIELDS: Record<string, string> = { subject: "{subject}", description: "{description}" };
export const DEFAULT_FILE_FIELD = "file";

export type FileMode = "combine" | "separate";

export type SendConfig = {
  submitUrl: string;
  /** Form field key → template with {subject}, {description} and {context}. */
  fields: Record<string, string>;
  /** Form field key for the pictures. Empty sends no pictures. */
  fileField: string;
  fileMode: FileMode;
  /** Where a record opens, with {key}. Empty when the form answer carries its own link. */
  recordUrl: string;
};

export type OutgoingFile = { name: string; type: string; bytes: Uint8Array };
export type Report = { subject: string; description: string; context: string; files: OutgoingFile[] };
export type SendResult = { ok: true; key: string | null; url: string | null } | { ok: false; error: string };

const FIELD_KEY = /^[A-Za-z0-9_.\-[\]]{1,100}$/;

/** Field templates from the settings: a JSON object of strings. Anything else is refused, the page says why. */
export function readFields(value: unknown): Record<string, string> | null {
  if (typeof value !== "string" || value.trim() === "") return { ...DEFAULT_FIELDS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FIELDS) return null;
  const fields: Record<string, string> = {};
  for (const [key, template] of entries) {
    if (!FIELD_KEY.test(key) || typeof template !== "string" || template.length > MAX_TEMPLATE_LENGTH) return null;
    fields[key] = template;
  }
  return fields;
}

export function readSendConfig(values: Record<string, unknown>): SendConfig | { error: string } {
  const submitUrl = readFormUrl(values.submitUrl);
  if (!submitUrl) return { error: "not-configured" };
  const fields = readFields(values.submitFields);
  if (!fields) return { error: "The form fields setting is not a JSON object of field names and templates." };
  const fileField = typeof values.fileField === "string" ? values.fileField.trim() : DEFAULT_FILE_FIELD;
  if (fileField && !FIELD_KEY.test(fileField)) return { error: "The picture field name setting has characters a form field cannot have." };
  const fileMode: FileMode = values.fileMode === "separate" ? "separate" : "combine";
  const recordUrl = typeof values.recordUrl === "string" && values.recordUrl.includes("{key}") ? values.recordUrl.trim() : "";
  return { submitUrl, fields, fileField, fileMode, recordUrl };
}

export function fillTemplate(template: string, report: Pick<Report, "subject" | "description" | "context">): string {
  return template.replace(/\{(subject|description|context)\}/g, (_, name: "subject" | "description" | "context") => report[name]).trim();
}

export function buildBody(config: SendConfig, report: Report): FormData {
  const body = new FormData();
  for (const [key, template] of Object.entries(config.fields)) body.append(key, fillTemplate(template, report));
  if (config.fileField) {
    for (const file of report.files) {
      body.append(config.fileField, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name);
    }
  }
  return body;
}

const RECORD_KEY = /\b[A-Z][A-Z0-9_]{1,30}-\d{1,9}\b/;
const KEY_FIELDS = ["key", "issue_key", "issueKey", "ticket_key", "ticketKey", "id"];
const URL_FIELDS = ["url", "issue_url", "issueUrl", "ticket_url", "ticketUrl", "link", "web_url", "webUrl"];

function pickString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof (value as { value?: unknown }).value === "string") {
    return pickString((value as { value: string }).value);
  }
  return null;
}

/** Looks for the record a form created in its answer: a key such as ABC-12 and a link, in JSON or in text. */
export function readAnswer(text: string, recordUrl: string): { key: string | null; url: string | null } {
  let key: string | null = null;
  let url: string | null = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    const object = node as Record<string, unknown>;
    for (const field of KEY_FIELDS) {
      const found = pickString(object[field]);
      if (!key && found && RECORD_KEY.test(found)) key = found.match(RECORD_KEY)![0];
    }
    for (const field of URL_FIELDS) {
      const found = pickString(object[field]);
      if (!url && found && readFormUrl(found)) url = readFormUrl(found);
    }
    for (const child of Object.values(object)) visit(child, depth + 1);
  };
  visit(parsed, 0);
  if (!key) key = text.match(RECORD_KEY)?.[0] ?? null;
  if (!url && key && recordUrl) url = readFormUrl(recordUrl.replaceAll("{key}", encodeURIComponent(key))) || null;
  return { key, url };
}

function httpError(status: number, text: string): string {
  const hint = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const what =
    status === 401 || status === 403
      ? "The form refused the report: it asks for a sign-in"
      : status === 404
        ? "The form was not found at the configured address"
        : status === 413
          ? "The form refused the report as too large. Remove a picture or attach smaller ones"
          : status >= 500
            ? "The form's server failed"
            : "The form refused the report";
  return `${what} (HTTP ${status})${hint ? `: ${hint}` : "."}`;
}

export async function sendReport(config: SendConfig, report: Report, fetcher: typeof fetch = fetch): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetcher(config.submitUrl, {
      method: "POST",
      body: buildBody(config, report),
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" },
      signal: controller.signal,
    });
    const text = (await response.text()).slice(0, MAX_ANSWER_CHARS);
    if (!response.ok) return { ok: false, error: httpError(response.status, text) };
    return { ok: true, ...readAnswer(text, config.recordUrl) };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: "The form did not answer in a minute. Check the network and send again." };
    const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
    return { ok: false, error: `Could not reach the form: ${cause}. Check the network or VPN and send again.` };
  } finally {
    clearTimeout(timer);
  }
}
