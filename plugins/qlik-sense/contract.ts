// The contract between the server entry and the host entry. The host entry runs
// on the machine where agents run: that machine reaches Qlik Sense, keeps the
// password in its own OS store, and holds the connection and report catalog.
// The server keeps no company data — only the agent policy.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const note = z.string().max(500);

export const catalogSheetSchema = z
  .object({ id: z.string().min(1).max(200), title: z.string().max(300), note })
  .strict();

export const catalogAppSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(300),
    stream: z.string().max(300).nullable(),
    note,
    sheets: z.array(catalogSheetSchema).max(300),
  })
  .strict();

/** Catalog shape under development; selection semantics await owner approval. */
export const catalogSchema = z.object({ apps: z.array(catalogAppSchema).max(200) }).strict();
export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogApp = z.infer<typeof catalogAppSchema>;

export const passwordStoreKindSchema = z.enum(["keychain", "dpapi", "file"]);
export type PasswordStoreKind = z.infer<typeof passwordStoreKindSchema>;

export const connectionStatusSchema = z
  .object({
    platform: z.string(),
    url: z.string().nullable(),
    user: z.string().nullable(),
    hasPassword: z.boolean(),
    passwordStore: passwordStoreKindSchema.nullable(),
    /** Why the last sign-in was refused. While set, nothing signs in again. */
    blocked: z.string().nullable(),
    /** The last sign-in check. `apps` is set when it succeeded; `message` is the technical detail. */
    lastCheck: z.object({ ok: z.boolean(), at: z.number(), message: z.string(), apps: z.number().int().nullable() }).strict().nullable(),
    catalogApps: z.number().int(),
  })
  .strict();
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const qlikAppSummarySchema = z
  .object({ id: z.string(), name: z.string(), stream: z.string().nullable(), reloaded: z.string().nullable() })
  .strict();
export type QlikAppSummary = z.infer<typeof qlikAppSummarySchema>;

export const qlikSheetSummarySchema = z
  .object({ id: z.string(), title: z.string(), description: z.string(), published: z.boolean().nullable(), link: z.string() })
  .strict();
export type QlikSheetSummary = z.infer<typeof qlikSheetSummarySchema>;

const filtersSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).max(200)]))
  .optional();

const appRef = z.string().max(300).optional();
export const MAX_ROWS = 2000;
const maxRows = z.number().int().min(1).max(MAX_ROWS).optional();

export const toolInputSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("reports") }).strict(),
  z.object({ tool: z.literal("sheets"), app: appRef }).strict(),
  z.object({ tool: z.literal("sheet_objects"), app: appRef, sheet: z.string().min(1).max(300) }).strict(),
  z.object({ tool: z.literal("fields"), app: appRef, search: z.string().max(200).optional() }).strict(),
  z
    .object({
      tool: z.literal("field_values"),
      app: appRef,
      field: z.string().min(1).max(300),
      search: z.string().max(200).optional(),
      filters: filtersSchema,
      limit: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),
  z
    .object({
      tool: z.literal("get_data"),
      app: appRef,
      object: z.string().min(1).max(200),
      filters: filtersSchema,
      maxRows,
      rawNumbers: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      tool: z.literal("query"),
      app: appRef,
      dimensions: z.array(z.string().max(300)).max(10).optional(),
      measures: z.array(z.string().max(1000)).max(20).optional(),
      filters: filtersSchema,
      maxRows,
      rawNumbers: z.boolean().optional(),
    })
    .strict(),
]);
export type ToolInput = z.infer<typeof toolInputSchema>;

export const toolOutputSchema = z.object({ text: z.string(), isError: z.boolean() }).strict();

export const checkLinkResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      app: z.object({ id: z.string(), name: z.string(), stream: z.string().nullable() }).strict(),
      sheet: z.object({ id: z.string(), title: z.string() }).strict().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("no-access"),
      appId: z.string(),
      /** The Qlik login, for the access request the panel writes. */
      user: z.string(),
      /** Qlik's own explanation, when it gave one. */
      detail: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("invalid"),
      reason: z.enum(["not-a-link", "other-site", "no-sheet"]),
      linkOrigin: z.string().optional(),
      setupOrigin: z.string().optional(),
      sheetId: z.string().optional(),
    })
    .strict(),
]);
export type CheckLinkResult = z.infer<typeof checkLinkResultSchema>;

export const checkSignInResultSchema = z
  .object({ ok: z.boolean(), message: z.string(), apps: z.number().int().nullable() })
  .strict();

export const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: connectionStatusSchema, experimental_retryable: true },
  saveConnection: {
    input: z
      .object({
        url: z.string().min(1).max(500),
        user: z.string().min(1).max(200),
        /** Omitted keeps the stored password. */
        password: z.string().min(1).max(500).optional(),
      })
      .strict(),
    output: connectionStatusSchema,
  },
  forget: { input: z.object({}).strict(), output: connectionStatusSchema },
  checkSignIn: {
    input: z.object({ retry: z.boolean().optional() }).strict(),
    output: checkSignInResultSchema,
  },
  listApps: {
    input: z.object({}).strict(),
    output: z.object({ apps: z.array(qlikAppSummarySchema) }).strict(),
    experimental_retryable: true,
  },
  listSheets: {
    input: z.object({ appId: z.string().min(1).max(200) }).strict(),
    output: z.object({ sheets: z.array(qlikSheetSummarySchema) }).strict(),
    experimental_retryable: true,
  },
  getCatalog: { input: z.object({}).strict(), output: catalogSchema, experimental_retryable: true },
  saveCatalog: { input: catalogSchema, output: catalogSchema },
  checkLink: { input: z.object({ link: z.string().min(1).max(2000) }).strict(), output: checkLinkResultSchema },
  tool: { input: toolInputSchema, output: toolOutputSchema },
});
