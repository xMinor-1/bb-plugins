// The contract between the server entry and the host entry. The host entry runs
// on the machine where agents run: that machine reaches the tracker (often only
// inside a corporate network), keeps the API key in its own OS store, and sends
// it to the configured address and nowhere else. The server holds the
// configuration and decides who may ask.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { LIMITS } from "./src/shared/limits";

export const keyStoreKindSchema = z.enum(["keychain", "credential-manager", "file"]);
export type KeyStoreKind = z.infer<typeof keyStoreKindSchema>;

/** Why a request failed. The panel turns each code into a sentence for a person. */
export const failureCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "notFound",
  "conflict",
  "redirect",
  "badRequest",
  "serverError",
  "notJson",
  "tls",
  "unreachable",
  "timeout",
  "noKey",
  "storeError",
  "addressChanged",
  "badAddress",
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

export const lastCheckSchema = z
  .object({ ok: z.boolean(), at: z.number(), code: failureCodeSchema.nullable(), status: z.number().int().nullable() })
  .strict();

export const keyStatusSchema = z
  .object({
    platform: z.string(),
    hasKey: z.boolean(),
    keyStore: keyStoreKindSchema.nullable(),
    /** The saved key belongs to another address: it is not sent until the person saves it again. */
    addressChanged: z.boolean(),
    lastCheck: lastCheckSchema.nullable(),
  })
  .strict();
export type KeyStatus = z.infer<typeof keyStatusSchema>;

const baseUrl = z.string().min(1).max(500);
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const headerValue = z.string().max(500).regex(/^[^\r\n]*$/);

/** How the key goes into a request: a header whose value is `format` with `{key}` replaced. */
export const authSchema = z
  .object({
    header: headerName,
    format: z.string().max(200).refine((value) => value.split("{key}").length === 2, "The format must contain {key} once"),
  })
  .strict();
export type Auth = z.infer<typeof authSchema>;

export const requestInputSchema = z
  .object({
    baseUrl,
    auth: authSchema,
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    path: z.string().min(1).max(2000),
    query: z.record(z.string().max(100), z.string().max(LIMITS.queryValue)),
    /** JSON text, already built from the configuration. */
    body: z.string().max(LIMITS.requestBody).nullable(),
    /** Static headers from the configuration, for example an organization id. Never the key. */
    headers: z.record(headerName, headerValue),
    /** Response headers the caller needs back, for example a total count. */
    exposeHeaders: z.array(headerName).max(6),
  })
  .strict();
export type RequestInput = z.infer<typeof requestInputSchema>;

export const requestOutputSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      status: z.number().int(),
      text: z.string(),
      truncated: z.boolean(),
      headers: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({ ok: z.literal(false), code: failureCodeSchema, status: z.number().int().nullable(), detail: z.string().max(500).nullable() })
    .strict(),
]);
export type RequestOutput = z.infer<typeof requestOutputSchema>;

export const hostContract = defineRpcContract({
  status: { input: z.object({ baseUrl: baseUrl.nullable() }).strict(), output: keyStatusSchema, experimental_retryable: true },
  saveKey: {
    input: z.object({ baseUrl, key: z.string().min(1).max(LIMITS.apiKey) }).strict(),
    output: keyStatusSchema,
  },
  forget: { input: z.object({ baseUrl: baseUrl.nullable() }).strict(), output: keyStatusSchema },
  /** Records the outcome of a sign-in check the server made with `request`. */
  recordCheck: {
    input: z.object({ ok: z.boolean(), code: failureCodeSchema.nullable(), status: z.number().int().nullable() }).strict(),
    output: keyStatusSchema,
  },
  request: { input: requestInputSchema, output: requestOutputSchema },
});
