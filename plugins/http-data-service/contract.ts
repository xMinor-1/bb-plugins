// The contract between the server entry and the host entry. The host entry runs
// on the machine where agents run: that machine reaches the service, keeps the
// password in its own OS store, and remembers a refused sign-in. The server holds
// the configuration and decides which agents may ask.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_QUERY_VALUE } from "./src/shared/service-config";

export const passwordStoreKindSchema = z.enum(["keychain", "credential-manager", "file"]);
export type PasswordStoreKind = z.infer<typeof passwordStoreKindSchema>;

/** Why a request failed. The panel turns each code into a sentence for a person. */
export const failureCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "notFound",
  "redirect",
  "badRequest",
  "serverError",
  "notJson",
  "tls",
  "unreachable",
  "timeout",
  "noPassword",
  "storeError",
  "addressChanged",
  "paused",
  "badAddress",
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

export const lastCheckSchema = z.object({ ok: z.boolean(), at: z.number(), code: failureCodeSchema.nullable(), status: z.number().int().nullable() }).strict();

export const connectionStatusSchema = z
  .object({
    platform: z.string(),
    user: z.string().nullable(),
    hasPassword: z.boolean(),
    passwordStore: passwordStoreKindSchema.nullable(),
    /** The service refused the password. While set, nothing signs in again. */
    blocked: z.boolean(),
    /** The saved sign-in belongs to another address: the password is not sent until the person confirms. */
    addressChanged: z.boolean(),
    lastCheck: lastCheckSchema.nullable(),
  })
  .strict();
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const checkResultSchema = z.object({ ok: z.boolean(), code: failureCodeSchema.nullable(), status: z.number().int().nullable() }).strict();
export type CheckResult = z.infer<typeof checkResultSchema>;

const baseUrl = z.string().min(1).max(500);
const path = z.string().min(1).max(300);

export const requestInputSchema = z
  .object({ baseUrl, path, query: z.record(z.string(), z.string().max(MAX_QUERY_VALUE)) })
  .strict();
export type RequestInput = z.infer<typeof requestInputSchema>;

export const requestOutputSchema = z
  .discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), text: z.string(), truncated: z.boolean() }).strict(),
    z.object({ ok: z.literal(false), code: failureCodeSchema, status: z.number().int().nullable(), detail: z.string().max(500).nullable() }).strict(),
  ]);
export type RequestOutput = z.infer<typeof requestOutputSchema>;

export const hostContract = defineRpcContract({
  status: { input: z.object({ baseUrl: baseUrl.nullable() }).strict(), output: connectionStatusSchema, experimental_retryable: true },
  saveConnection: {
    input: z
      .object({
        baseUrl,
        user: z.string().min(1).max(200),
        /** Omitted keeps the stored password. */
        password: z.string().min(1).max(500).optional(),
      })
      .strict(),
    output: connectionStatusSchema,
  },
  forget: { input: z.object({ baseUrl: baseUrl.nullable() }).strict(), output: connectionStatusSchema },
  checkSignIn: {
    input: z.object({ baseUrl, path, retry: z.boolean().optional() }).strict(),
    output: checkResultSchema,
  },
  request: { input: requestInputSchema, output: requestOutputSchema },
});
