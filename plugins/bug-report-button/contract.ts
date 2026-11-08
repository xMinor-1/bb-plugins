// The contract between the server entry and the host entry for the REST mode. The host entry runs on the person's
// machine: it reaches the tracker (often only inside a company network), keeps their API key in the OS store, and
// sends it to the configured address and nowhere else. The server holds the settings and builds the requests.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from "./src/report";

export const KEY_SOURCES = ["own", "shared"] as const;
export const keyStoreKindSchema = z.enum(["keychain", "credential-manager", "file"]);

/** Why a request failed. The page turns each code into a sentence for a person. */
export const failureCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "notFound",
  "tooLarge",
  "badRequest",
  "redirect",
  "serverError",
  "unreachable",
  "timeout",
  "noKey",
  "storeError",
  "badAddress",
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

export const keyStatusSchema = z
  .object({
    hasKey: z.boolean(),
    /** "own": saved on this page; "shared": the key another plugin keeps for the same address. */
    source: z.enum(KEY_SOURCES).nullable(),
    keyStore: keyStoreKindSchema.nullable(),
  })
  .strict();
export type KeyStatus = z.infer<typeof keyStatusSchema>;

const baseUrl = z.string().min(1).max(500);
/** A plugin whose key this one may use when it has none of its own, such as "tracker-board". */
const shareWith = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/).nullable();
export const authSchema = z
  .object({
    header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    format: z.string().max(200).refine((value) => value.split("{key}").length === 2, "The format must contain {key} once"),
  })
  .strict();
export type Auth = z.infer<typeof authSchema>;

const fileSchema = z.object({ name: z.string().min(1).max(200), type: z.enum(IMAGE_TYPES), base64: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4) }).strict();
const target = { baseUrl, shareWith, auth: authSchema, path: z.string().min(1).max(2000) };

export const answerSchema = z.union([
  z.object({ ok: z.literal(true), status: z.number().int(), text: z.string() }).strict(),
  z.object({ ok: z.literal(false), code: failureCodeSchema, status: z.number().int().nullable(), detail: z.string().nullable() }).strict(),
]);
export type Answer = z.infer<typeof answerSchema>;

export const hostContract = defineRpcContract({
  status: { input: z.object({ baseUrl, shareWith }).strict(), output: keyStatusSchema },
  saveKey: { input: z.object({ baseUrl, shareWith, key: z.string().min(1).max(8192) }).strict(), output: keyStatusSchema },
  forget: { input: z.object({ baseUrl, shareWith }).strict(), output: keyStatusSchema },
  /** POST of a JSON body. */
  postJson: { input: z.object({ ...target, body: z.string().max(200_000) }).strict(), output: answerSchema },
  /** POST of a form as multipart/form-data: text fields and files under one field name. */
  postForm: {
    input: z
      .object({
        ...target,
        fields: z.record(z.string().regex(/^[A-Za-z0-9_.\-[\]]{1,100}$/), z.string().max(20_000)).refine((value) => Object.keys(value).length <= 20, "Too many fields"),
        field: z.string().regex(/^[A-Za-z0-9_.\-[\]]{0,100}$/),
        files: z.array(fileSchema).max(MAX_IMAGES),
      })
      .strict(),
    output: answerSchema,
  },
  /** POST of one file as multipart/form-data. */
  postFile: {
    input: z
      .object({
        ...target,
        field: z.string().regex(/^[A-Za-z0-9_.\-[\]]{1,100}$/),
        file: fileSchema,
      })
      .strict(),
    output: answerSchema,
  },
});
