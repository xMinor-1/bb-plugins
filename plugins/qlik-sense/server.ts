// bb-plugin-qlik-sense — server entry.
//
// The server keeps no company data. Qlik is reached from the host entry on the
// machine where agents run (src/host.ts); this module decides WHO may get the
// answers:
//   1. Agent tools and the skill are offered only to provider/model pairs the
//      user allowed (`configure`).
//   2. Each tool call re-checks the model the thread is running right now
//      (recorded by the dispatch hook), so switching models mid-thread does not
//      keep the tools working.
//   3. A thread that has received Qlik answers is marked; the dispatch hook
//      refuses to send such a thread to a model outside the allow-list, because
//      the whole history — Qlik answers included — would go to that model.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { catalogSchema, checkLinkResultSchema, checkSignInResultSchema, connectionStatusSchema, hostContract, MAX_ROWS, qlikAppSummarySchema, qlikSheetSummarySchema, type ToolInput } from "./contract";
import { normalizeBaseUrl } from "./src/shared/links";
import { groupModels } from "./src/shared/models";
import { createPolicy, formatRules, parseRules, PolicyError, type Policy } from "./src/shared/policy";

const hostIdInput = z.object({ hostId: z.string().min(1).max(200) }).strict();
const ruleSchema = z.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(300) }).strict();

const machineSchema = z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).strict();
const modelGroupSchema = z
  .object({ pattern: z.string(), label: z.string(), models: z.array(z.string()) })
  .strict();
const agentProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    groups: z.array(modelGroupSchema),
    error: z.string().nullable(),
  })
  .strict();
const agentsOutputSchema = z.object({ providers: z.array(agentProviderSchema) }).strict();
export type AgentsView = z.infer<typeof agentsOutputSchema>;

export const rpcContract = defineRpcContract({
  machines: {
    input: z.null(),
    output: z
      .object({ machines: z.array(machineSchema), lastUsed: z.string().nullable(), suggestedUrl: z.string() })
      .strict(),
  },
  status: { input: hostIdInput, output: connectionStatusSchema },
  saveConnection: {
    input: hostIdInput.extend({ url: z.string().min(1).max(500), user: z.string().min(1).max(200), password: z.string().min(1).max(500).optional() }),
    output: connectionStatusSchema,
  },
  forget: { input: hostIdInput, output: connectionStatusSchema },
  checkSignIn: { input: hostIdInput.extend({ retry: z.boolean().optional() }), output: checkSignInResultSchema },
  listApps: { input: hostIdInput, output: z.object({ apps: z.array(qlikAppSummarySchema) }).strict() },
  listSheets: { input: hostIdInput.extend({ appId: z.string().min(1).max(200) }), output: z.object({ sheets: z.array(qlikSheetSummarySchema) }).strict() },
  getCatalog: { input: hostIdInput, output: catalogSchema },
  saveCatalog: { input: hostIdInput.extend({ catalog: catalogSchema }), output: catalogSchema },
  checkLink: { input: hostIdInput.extend({ link: z.string().min(1).max(2000) }), output: checkLinkResultSchema },
  policy: { input: z.null(), output: z.object({ rules: z.array(ruleSchema), error: z.string().nullable() }).strict() },
  savePolicy: { input: z.object({ rules: z.array(ruleSchema).max(200) }).strict(), output: z.object({ rules: z.array(ruleSchema), error: z.string().nullable() }).strict() },
  agents: { input: hostIdInput, output: agentsOutputSchema },
});

const SKILL = "qlik-sense";
const DATA_TIMEOUT_MS = 300_000;
const MODELS_TIMEOUT_MS = 15_000;

const appParam = z.string().max(300).optional().describe("App id or name from qlik_reports. May be omitted when only one app is enabled.");
const filtersParam = z
  .record(z.string(), z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]))
  .optional()
  .describe(
    'Filters: { "Field": "value" } or { "Field": ["value 1", "value 2"] }, values exactly as in Qlik (see qlik_field_values). ' +
      'Qlik search strings work too: "*North*", ">=100<=200", ">=01.10.2026<=31.10.2026".',
  );
const maxRowsParam = z.number().int().min(1).max(MAX_ROWS).optional().describe(`Rows to return, 100 by default, at most ${MAX_ROWS}`);
const rawParam = z.boolean().optional().describe("true returns measures as plain numbers without formatting, for calculations");

const REPORTS_INSTRUCTIONS =
  "Qlik Sense: before answering a question about business numbers, call qlik_reports — it lists the reports the user enabled, " +
  "what each is for, and links to open them. Only those apps can be read. Every data call recalculates on current data with the " +
  "filters you pass; filters from earlier calls are not kept. Quote the sheet link with the numbers so the user can check them.";

interface Execution {
  providerId: string;
  model: string | null;
  at: number;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    url: {
      type: "string",
      label: "Qlik Sense address",
      description: "Suggested in the Qlik Sense panel when a machine is not set up yet, so people only enter their login and password.",
      default: "",
      experimental_schema: z.string().max(500).refine((value) => {
        if (value.trim() === "") return true;
        try {
          normalizeBaseUrl(value);
          return true;
        } catch {
          return false;
        }
      }, "Use the https:// address of Qlik Sense"),
    },
    allowedModels: {
      type: "string",
      label: "Agents allowed to read Qlik data",
      description:
        "One rule per line: <provider-id> <model-glob>, for example `acp-opencode corp/*`. Empty means no agent gets Qlik tools. Edit it in the Qlik Sense panel → Agents.",
      experimental_multiline: true,
      default: "",
      experimental_schema: z.string().max(8000).refine((value) => {
        try {
          parseRules(value);
          return true;
        } catch {
          return false;
        }
      }, "Each line must be: <provider-id> <model-glob>"),
    },
  });

  let policy: Policy = createPolicy([]);
  let policyError: string | null = null;
  const applyPolicy = (text: string) => {
    try {
      policy = createPolicy(parseRules(text));
      policyError = null;
    } catch (error) {
      // A broken rule list fails closed: nobody gets Qlik data until it is fixed.
      policy = createPolicy([]);
      policyError = error instanceof PolicyError ? error.message : String(error);
    }
  };
  applyPolicy((await settings.get()).allowedModels);
  settings.onChange((next) => applyPolicy(next.allowedModels));

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const kv = bb.storage.kv;
  const execKey = (threadId: string) => `exec:${threadId}`;
  const taintKey = (threadId: string) => `taint:${threadId}`;

  async function isTainted(threadId: string | null | undefined): Promise<boolean> {
    if (!threadId) return false;
    return ((await kv.get(taintKey(threadId))) ?? null) !== null;
  }
  const markTainted = (threadId: string) => kv.set(taintKey(threadId), { at: Date.now() });

  // ---------- Who may receive Qlik data ----------

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const { providerId, model } = ctx.requestedExecution;
    const thread = ctx.thread;
    const tainted = (await isTainted(thread.id)) || (await isTainted(thread.sourceThreadId));
    if (tainted && !policy.allows(providerId, model)) {
      return {
        action: "reject",
        message:
          "This thread contains Qlik Sense data, so only the models allowed in Qlik Sense → Agents can continue it. " +
          "Switch back to one of them, or start a new thread.",
      };
    }
    if (tainted && thread.sourceThreadId && !(await isTainted(thread.id))) await markTainted(thread.id);
    // Tool calls check the model of the turn that is running, not the one the thread started with.
    await kv.set(execKey(thread.id), { providerId, model, at: Date.now() } satisfies Execution);
    return { action: "proceed" };
  });

  bb.agents.configure((ctx) =>
    policy.allows(ctx.provider.id, ctx.provider.model) ? { tools: TOOL_NAMES, skills: [SKILL] } : { tools: [], skills: [] },
  );

  bb.events.on("thread.deleted", async ({ thread }) => {
    await kv.delete(execKey(thread.id));
    await kv.delete(taintKey(thread.id));
  });

  /** The machine a thread runs on, once the model it is running is allowed. */
  async function gate(threadId: string): Promise<{ ok: true; hostId: string } | { ok: false; message: string }> {
    const execution = await kv.get<Execution>(execKey(threadId));
    if (!execution || !policy.allows(execution.providerId, execution.model)) {
      const who = execution ? `${execution.providerId} ${execution.model ?? "(default model)"}` : "this agent";
      return {
        ok: false,
        message: `Qlik Sense data is not available to ${who}. Only the models allowed in the Qlik Sense panel → Agents can read it.`,
      };
    }
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return { ok: false, message: "This thread has no machine to reach Qlik Sense from yet." };
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return { ok: true, hostId: environment.hostId };
  }

  // ---------- Agent tools ----------

  type ToolArgs<T extends ToolInput["tool"]> = Omit<Extract<ToolInput, { tool: T }>, "tool">;
  async function runTool(threadId: string, input: ToolInput, signal: AbortSignal | undefined) {
    const allowed = await gate(threadId);
    if (!allowed.ok) return { content: [{ type: "text" as const, text: allowed.message }], isError: true };
    // Marked before the call: even sheet names are company data.
    await markTainted(threadId);
    const result = await host.call("tool", input, { hostId: allowed.hostId, signal, timeoutMs: DATA_TIMEOUT_MS });
    return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
  }

  const label = (pending: string, completed: string) => ({ label: { pending, completed } });

  bb.agents.registerTool({
    name: "qlik_reports",
    description: "The Qlik Sense reports the user enabled for agents: apps, recommended sheets, what each is for, and links to open them.",
    instructions: REPORTS_INSTRUCTIONS,
    presentation: label("Reading the Qlik report list", "Read the Qlik report list"),
    parameters: z.object({}),
    execute: (_params, ctx) => runTool(ctx.threadId, { tool: "reports" }, ctx.signal),
  });

  bb.agents.registerTool({
    name: "qlik_list_sheets",
    description: "Sheets (pages) of an enabled Qlik app: id, title, number of objects, link, and which sheets the user recommended.",
    presentation: label("Listing Qlik sheets", "Listed Qlik sheets"),
    parameters: z.object({ app: appParam }),
    execute: (params: ToolArgs<"sheets">, ctx) => runTool(ctx.threadId, { tool: "sheets", ...params }, ctx.signal),
  });

  bb.agents.registerTool({
    name: "qlik_sheet_objects",
    description: "What a sheet shows: tables, charts, KPIs and filter panes with their ids, dimensions and measures. The id goes to qlik_get_data.",
    presentation: label("Reading a Qlik sheet", "Read a Qlik sheet"),
    parameters: z.object({ sheet: z.string().min(1).max(300).describe("Sheet id or title (a part of the title works)"), app: appParam }),
    execute: (params: ToolArgs<"sheet_objects">, ctx) => runTool(ctx.threadId, { tool: "sheet_objects", ...params }, ctx.signal),
  });

  bb.agents.registerTool({
    name: "qlik_list_fields",
    description: "Fields of the data model (for filters and breakdowns), master dimensions, and master measures with their formulas.",
    presentation: label("Listing Qlik fields", "Listed Qlik fields"),
    parameters: z.object({ search: z.string().max(200).optional().describe("Part of a name"), app: appParam }),
    execute: (params: ToolArgs<"fields">, ctx) => runTool(ctx.threadId, { tool: "fields", ...params }, ctx.signal),
  });

  bb.agents.registerTool({
    name: "qlik_field_values",
    description:
      "Values of a field, to build filters. With filters it shows which values remain possible: selected and possible first, then excluded.",
    presentation: label("Reading Qlik field values", "Read Qlik field values"),
    parameters: z.object({
      field: z.string().min(1).max(300).describe("Field name"),
      search: z.string().max(200).optional().describe('Search within the values, for example "north"'),
      filters: filtersParam,
      limit: z.number().int().min(1).max(1000).optional().describe("Values to return, 100 by default"),
      app: appParam,
    }),
    execute: (params: ToolArgs<"field_values">, ctx) => runTool(ctx.threadId, { tool: "field_values", ...params }, ctx.signal),
  });

  bb.agents.registerTool({
    name: "qlik_get_data",
    description: "Data of a table, chart, pivot or KPI from a sheet, as a table recalculated by the Qlik engine with the given filters.",
    presentation: label("Reading Qlik data", "Read Qlik data"),
    parameters: z.object({
      object: z.string().min(1).max(200).describe("Object id from qlik_sheet_objects"),
      filters: filtersParam,
      max_rows: maxRowsParam,
      raw_numbers: rawParam,
      app: appParam,
    }),
    execute: ({ object, filters, max_rows, raw_numbers, app }, ctx) =>
      runTool(ctx.threadId, { tool: "get_data", object, filters, maxRows: max_rows, rawNumbers: raw_numbers, app }, ctx.signal),
  });

  bb.agents.registerTool({
    name: "qlik_query",
    description:
      "Calculate your own table: dimensions are fields or master dimensions; measures are master measures by name or Qlik formulas " +
      "(Sum(Field), Count(distinct Field)). Sorted by the first measure, descending.",
    presentation: label("Calculating in Qlik", "Calculated in Qlik"),
    parameters: z.object({
      dimensions: z.array(z.string().max(300)).max(10).optional().describe("Fields or master dimensions to break down by"),
      measures: z.array(z.string().max(1000)).max(20).optional().describe("Master measures or formulas"),
      filters: filtersParam,
      max_rows: maxRowsParam,
      raw_numbers: rawParam,
      app: appParam,
    }),
    execute: ({ dimensions, measures, filters, max_rows, raw_numbers, app }, ctx) =>
      runTool(ctx.threadId, { tool: "query", dimensions, measures, filters, maxRows: max_rows, rawNumbers: raw_numbers, app }, ctx.signal),
  });

  // ---------- The setup panel ----------

  const call = <M extends keyof typeof hostContract & string>(method: M, hostId: string, input: Parameters<typeof host.call<M>>[1], timeoutMs = 60_000) =>
    host.call(method, input, { hostId, timeoutMs });

  const policyView = () => ({ rules: [...policy.rules], error: policyError });

  bb.rpc.register(rpcContract, {
    machines: async () => {
      const hosts = await bb.sdk.hosts.list();
      const machines = hosts
        .filter((candidate) => candidate.lifecycle.phase !== "destroyed")
        .map((candidate) => ({ id: candidate.id, name: candidate.name, connected: candidate.status === "connected" }));
      const { url } = await settings.get();
      return { machines, lastUsed: (await kv.get<string>("ui:lastHost")) ?? null, suggestedUrl: url.trim() };
    },
    status: async ({ hostId }) => {
      await kv.set("ui:lastHost", hostId);
      return call("status", hostId, {});
    },
    saveConnection: ({ hostId, url, user, password }) => call("saveConnection", hostId, { url, user, ...(password ? { password } : {}) }),
    forget: ({ hostId }) => call("forget", hostId, {}),
    checkSignIn: ({ hostId, retry }) => call("checkSignIn", hostId, { retry }, 120_000),
    listApps: ({ hostId }) => call("listApps", hostId, {}, 120_000),
    listSheets: ({ hostId, appId }) => call("listSheets", hostId, { appId }, 120_000),
    getCatalog: ({ hostId }) => call("getCatalog", hostId, {}),
    saveCatalog: ({ hostId, catalog }) => call("saveCatalog", hostId, catalog),
    checkLink: ({ hostId, link }) => call("checkLink", hostId, { link }, 120_000),
    policy: () => policyView(),
    savePolicy: async ({ rules }) => {
      const text = formatRules(parseRules(formatRules(rules)));
      await settings.experimental_set({ allowedModels: text });
      applyPolicy(text);
      return policyView();
    },
    agents: async ({ hostId }) => {
      const providers = await bb.sdk.providers.list({ hostId });
      const out = await Promise.all(
        providers
          .filter((provider) => provider.available)
          .map(async (provider) => {
            try {
              const result = await withTimeout(bb.sdk.providers.models({ providerId: provider.id, hostId }), MODELS_TIMEOUT_MS);
              return { id: provider.id, name: provider.displayName, groups: groupModels(result.models), error: result.modelLoadError?.detail ?? null };
            } catch (error) {
              return { id: provider.id, name: provider.displayName, groups: [], error: error instanceof Error ? error.message : String(error) };
            }
          }),
      );
      return { providers: out };
    },
  });
}

const TOOL_NAMES = ["qlik_reports", "qlik_list_sheets", "qlik_sheet_objects", "qlik_list_fields", "qlik_field_values", "qlik_get_data", "qlik_query"];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
