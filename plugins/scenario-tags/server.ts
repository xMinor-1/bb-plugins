// Scenario Tags — server side.
//
// It holds the scenario catalog setting (one JSON string, usually written by
// a build manifest), the texts the tag row puts into the message box, the
// person's own pinned tags and own scenarios, the `scenario_save` agent tool
// that saves a scenario after the person confirms it, and a CLI command that
// checks the catalog. The tags, the form and the inserted prompt live in app.tsx.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applyCuration,
  baselineCuration,
  checkScenario,
  EMPTY_CURATION,
  hiddenScenarios,
  MAX_HIDDEN,
  MAX_SEEN,
  newScenarioIds,
  fieldSchema,
  MAX_CATALOG_CHARS,
  MAX_OWN,
  MINE_GROUP,
  OWN_PREFIX,
  parseCatalog,
  rowScenarios,
  withOwn,
  type Catalog,
  type Curation,
  type CurationChange,
  type OwnPins,
  type Scenario,
} from "./src/catalog";
import { DEFAULT_BUILDER_PROMPT, DEFAULT_EDIT_PROMPT, DEFAULT_SAVE_CHAT_PROMPT, SAVE_TOOL } from "./src/prompts";
import { CURATION_CHANGED, MAX_PINS, OWN_CHANGED, PINS_CHANGED, PREVIEW_RENDERER, type PreviewDecision, type PreviewPayload } from "./src/shared";

const scenarioId = z.string().min(1).max(64);
const ownPinsSchema = z.object({
  pins: z.array(scenarioId).max(MAX_PINS),
  known: z.array(scenarioId).max(500),
});

const curationSchema = z.object({
  hidden: z.array(scenarioId).max(MAX_HIDDEN),
  seen: z.array(scenarioId).max(MAX_SEEN).nullable(),
});
const idList = z.array(scenarioId).max(MAX_SEEN).optional();

export const rpcContract = defineRpcContract({
  pins_get: {
    input: z.null(),
    output: z.object({ own: ownPinsSchema.nullable() }),
  },
  /** `null` returns to the catalog's own pick. */
  pins_set: {
    input: z.object({ own: ownPinsSchema.nullable() }),
    output: z.object({ own: ownPinsSchema.nullable() }),
  },
  /** The person's own scenarios; they are checked again on every read. */
  own_list: {
    input: z.null(),
    output: z.object({ scenarios: z.array(z.unknown()) }),
  },
  own_delete: {
    input: z.object({ id: scenarioId }),
    output: z.object({ removed: z.boolean() }),
  },
  /** Hidden catalog scenarios and the ids the person has seen; the first read sets the baseline. */
  curation_get: {
    input: z.null(),
    output: curationSchema,
  },
  /** Hide, show again, or mark scenarios seen; returns the stored state. */
  curation_update: {
    input: z.object({ hide: idList, unhide: idList, seen: idList }),
    output: curationSchema,
  },
});
export type RpcContract = typeof rpcContract;

const PINS_KEY = "pins";
const OWN_KEY = "own-scenarios";
const CURATION_KEY = "curation";

export const CATALOG_HELP =
  "The tags above the message box, as JSON: `{ \"groups\": [{ \"id\", \"label\" }], \"scenarios\": [{ \"id\", \"label\", \"group\", \"pinned\", \"fields\": [{ \"id\", \"label\", \"type\": \"text\" | \"textarea\" | \"select\" | \"attachment\", \"required\" }], \"prompt\" }] }`. " +
  "In `prompt`, `{{field}}` takes an answer and `{{answers}}` lists the others; a line whose answers are all empty is left out. " +
  "Run `bb scenario-tags check` after a change. A build manifest usually writes this setting.";

const toolParameters = z.object({
  id: z
    .string()
    .max(64)
    .optional()
    .describe(`To change one of the person's own scenarios, its id (starts with "${OWN_PREFIX}"). Leave out for a new one.`),
  label: z.string().trim().min(1).max(30).describe("The tag text, up to 30 characters, in the person's language."),
  description: z.string().max(300).optional().describe("One line: what the scenario does."),
  fields: z
    .array(fieldSchema)
    .max(12)
    .optional()
    .describe("Questions the form asks before each run. `id`: letters, digits, _ . -. `type`: text, textarea, select (with `options`) or attachment (a file attached to the message)."),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .describe("The text put into the message box. {{field_id}} takes an answer; a line whose answers are all empty is left out. Name the tools or skills to use in plain words."),
});

const multiline = (label: string, description: string, fallback: string) =>
  ({ type: "string", label, description, experimental_multiline: true, default: fallback }) as const;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    scenarios: {
      type: "string",
      label: "Scenario catalog",
      description: CATALOG_HELP,
      experimental_multiline: true,
      experimental_schema: {
        "~standard": {
          version: 1,
          vendor: "scenario-tags",
          validate: (value: unknown) =>
            typeof value === "string" && value.length <= MAX_CATALOG_CHARS
              ? { value }
              : { issues: [{ message: `Up to ${MAX_CATALOG_CHARS} characters of JSON` }] },
        },
      },
      default: "",
    },
    builderPrompt: multiline(
      "New scenario prompt",
      `What "New scenario" puts into the message box: the agent asks about the task and saves the scenario with ${SAVE_TOOL}.`,
      DEFAULT_BUILDER_PROMPT,
    ),
    saveChatPrompt: multiline(
      "Save conversation prompt",
      `What "Save as scenario" puts into the message box: the agent turns the conversation into a scenario and saves it with ${SAVE_TOOL}.`,
      DEFAULT_SAVE_CHAT_PROMPT,
    ),
    editPrompt: multiline(
      "Change scenario prompt",
      "What \"Edit\" on an own scenario puts into the message box. {{label}}, {{id}} and {{scenario}} (its JSON) are filled in.",
      DEFAULT_EDIT_PROMPT,
    ),
    suggestEmail: {
      type: "string",
      label: "Suggest to: email",
      description: "Where \"Suggest to everyone\" offers to send an own scenario. Empty: the person only downloads or copies the file.",
      default: "",
    },
    suggestHint: multiline(
      "Suggest to: instructions",
      "Shown with \"Suggest to everyone\": who adds suggested scenarios to the catalog and how to send the file.",
      "",
    ),
  });

  async function readPins(): Promise<OwnPins | null> {
    const parsed = ownPinsSchema.safeParse(await bb.storage.kv.get(PINS_KEY));
    return parsed.success ? parsed.data : null;
  }

  /** Stored own scenarios that still pass the checks; anything else is left out. */
  async function readOwn(): Promise<Scenario[]> {
    const stored = await bb.storage.kv.get<unknown>(OWN_KEY);
    if (!Array.isArray(stored)) return [];
    const scenarios: Scenario[] = [];
    for (const entry of stored.slice(0, MAX_OWN)) {
      const checked = checkScenario(entry);
      if ("scenario" in checked && checked.scenario.id.startsWith(OWN_PREFIX)) {
        scenarios.push({ ...checked.scenario, group: MINE_GROUP, pinned: false });
      }
    }
    return scenarios;
  }

  async function writeOwn(scenarios: Scenario[]): Promise<void> {
    await bb.storage.kv.set(OWN_KEY, scenarios);
    bb.realtime.publish(OWN_CHANGED, {});
  }

  async function catalogNow(): Promise<Catalog> {
    const { scenarios } = await settings.get();
    return parseCatalog(scenarios);
  }

  async function readCuration(): Promise<Curation> {
    const parsed = curationSchema.safeParse(await bb.storage.kv.get(CURATION_KEY));
    return parsed.success ? parsed.data : EMPTY_CURATION;
  }

  /** The stored curation, with the first baseline written once the catalog has scenarios. */
  async function curationWithBaseline(catalog?: Catalog): Promise<Curation> {
    const current = await readCuration();
    const baseline = baselineCuration(current, catalog ?? (await catalogNow()));
    if (!baseline) return current;
    await bb.storage.kv.set(CURATION_KEY, baseline);
    return baseline;
  }

  /** One change at a time, so two message boxes hiding at once both land. */
  let queue: Promise<unknown> = Promise.resolve();
  function updateCuration(change: CurationChange): Promise<Curation> {
    const run = queue.then(async () => {
      const { next, changed } = applyCuration(await curationWithBaseline(), change);
      if (!changed) return next;
      await bb.storage.kv.set(CURATION_KEY, next);
      bb.realtime.publish(CURATION_CHANGED, {});
      return next;
    });
    queue = run.catch(() => {});
    return run;
  }

  // The catalog the person starts with is not "new": set the baseline at load.
  await curationWithBaseline().catch(() => undefined);

  bb.rpc.register(rpcContract, {
    pins_get: async () => ({ own: await readPins() }),
    pins_set: async ({ own }) => {
      if (own === null) await bb.storage.kv.delete(PINS_KEY);
      else await bb.storage.kv.set(PINS_KEY, own);
      bb.realtime.publish(PINS_CHANGED, {});
      return { own };
    },
    own_list: async () => ({ scenarios: await readOwn() }),
    // Through the queue too: the first read may write the baseline.
    curation_get: async () => updateCuration({}),
    curation_update: async (change) => updateCuration(change),
    own_delete: async ({ id }) => {
      const current = await readOwn();
      const next = current.filter((scenario) => scenario.id !== id);
      if (next.length === current.length) return { removed: false };
      await writeOwn(next);
      return { removed: true };
    },
  });

  bb.agents.registerTool({
    name: SAVE_TOOL,
    description:
      "Save a scenario tag for the person: a label, form questions and the prompt the tag puts into the message box. " +
      "The person sees a preview and confirms it; it then shows under My scenarios above the message box. Use only when the person asks to create, save or change a scenario.",
    instructions: `${SAVE_TOOL} saves a scenario tag after the person confirms a preview. Use it only when they ask to make, save or change a scenario.`,
    presentation: { label: { pending: "Saving a scenario", completed: "Saved a scenario" } },
    parameters: toolParameters,
    async execute(params, ctx) {
      const current = await readOwn();
      const existing = params.id ? current.find((scenario) => scenario.id === params.id) ?? null : null;
      if (params.id && !existing) {
        return { content: [{ type: "text", text: `No own scenario has the id "${params.id}". Leave out id to save a new one.` }], isError: true };
      }
      if (!existing && current.length >= MAX_OWN) {
        return { content: [{ type: "text", text: `The person already has ${MAX_OWN} own scenarios. Ask them to delete one first.` }], isError: true };
      }
      const candidate = {
        id: existing?.id ?? `${OWN_PREFIX}${randomUUID().slice(0, 8)}`,
        label: params.label,
        group: MINE_GROUP,
        ...(params.description ? { description: params.description } : {}),
        fields: params.fields ?? [],
        prompt: params.prompt,
      };
      const checked = checkScenario(candidate);
      if ("problem" in checked) {
        return { content: [{ type: "text", text: `The scenario is not valid: ${checked.problem}. Fix it and call ${SAVE_TOOL} again.` }], isError: true };
      }
      const scenario = checked.scenario;
      const payload: PreviewPayload = { scenario, replaces: existing?.label ?? null };
      const answer = await bb.ui.requestInput(
        {
          threadId: ctx.threadId,
          rendererId: PREVIEW_RENDERER,
          title: scenario.label,
          payload: payload as never,
          timeoutMs: 30 * 60_000,
          presentation: { label: { pending: "Waiting for the scenario preview", completed: "Scenario preview answered" } },
          describeSubmission: (value) => ({
            title: (value as PreviewDecision | null)?.save ? `Saved “${scenario.label}”` : `Did not save “${scenario.label}”`,
          }),
        },
        { signal: ctx.signal },
      );
      const decision = answer.outcome === "submitted" ? (answer.value as PreviewDecision | null) : null;
      if (!decision?.save) {
        return `The person did not save the scenario “${scenario.label}”. Ask what to change, or stop if they no longer want it.`;
      }
      const latest = await readOwn();
      const next = latest.some((item) => item.id === scenario.id)
        ? latest.map((item) => (item.id === scenario.id ? scenario : item))
        : [...latest, scenario];
      await writeOwn(next);
      return `Saved “${scenario.label}” (id ${scenario.id}) under My scenarios above the message box. The tag works now; it stays after restarts and build updates.`;
    },
  });

  bb.agents.configure(() => ({ tools: [SAVE_TOOL], skills: ["scenario-tags"] }));

  const usage = [
    "Usage:",
    "  bb scenario-tags check [--json]    Check the scenario catalog setting and list what the tags show",
    "  bb scenario-tags reset-pins        Return the collapsed row to the catalog's own pick",
    "  bb scenario-tags remove-own <id>   Delete one of the person's own scenarios",
    "  bb scenario-tags unhide <id|--all> Show a hidden catalog scenario again",
  ].join("\n");

  bb.cli.register({
    name: "scenario-tags",
    summary: "Check the scenario catalog behind the tags above the message box",
    commands: [
      { name: "check", summary: "Check the scenario catalog and list own scenarios", usage: "bb scenario-tags check [--json]" },
      { name: "reset-pins", summary: "Drop the person's own pinned tags", usage: "bb scenario-tags reset-pins" },
      { name: "remove-own", summary: "Delete one of the person's own scenarios", usage: "bb scenario-tags remove-own <id>" },
      { name: "unhide", summary: "Show a hidden catalog scenario again", usage: "bb scenario-tags unhide <id|--all>" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      if (command === "check") {
        const catalog = await catalogNow();
        const ownScenarios = await readOwn();
        const pins = await readPins();
        const curation = await curationWithBaseline(catalog);
        const row = rowScenarios(withOwn(catalog, ownScenarios, "Mine"), pins, curation.hidden).map((scenario) => scenario.id);
        const hidden = hiddenScenarios(catalog, curation.hidden).map((scenario) => scenario.id);
        const fresh = newScenarioIds(catalog, curation.seen);
        const mark = (id: string) =>
          `${row.includes(id) ? "  (in the row)" : ""}${hidden.includes(id) ? "  (hidden)" : ""}${fresh.has(id) ? "  (new)" : ""}`;
        const exitCode = catalog.problems.length > 0 ? 1 : 0;
        if (json) {
          return {
            exitCode,
            stdout: JSON.stringify({
              scenarios: catalog.scenarios.map(({ id, label, group }) => ({ id, label, group: group ?? null })),
              own: ownScenarios.map(({ id, label }) => ({ id, label })),
              row,
              hidden,
              new: [...fresh],
              ownPins: pins !== null,
              problems: catalog.problems,
            }),
          };
        }
        const lines = [
          catalog.scenarios.length === 0
            ? "The catalog is empty."
            : `${catalog.scenarios.length} scenario(s) in ${catalog.groups.length} group(s).`,
          ...catalog.scenarios.map((s) => `  ${s.id}  ${s.label}${s.group ? `  [${s.group}]` : ""}${mark(s.id)}`),
          hidden.length === 0 ? "Nothing is hidden." : `${hidden.length} hidden: ${hidden.join(", ")}. "bb scenario-tags unhide <id>" shows one again.`,
          ownScenarios.length === 0 ? "No own scenarios." : `${ownScenarios.length} own scenario(s):`,
          ...ownScenarios.map((s) => `  ${s.id}  ${s.label}${row.includes(s.id) ? "  (in the row)" : ""}`),
          pins !== null ? "The person pinned their own tags." : "The row shows the catalog's pinned tags.",
          ...catalog.problems.slice(0, 20).map((problem) => `Problem: ${problem}`),
        ];
        return { exitCode, stdout: lines.join("\n") };
      }
      if (command === "reset-pins") {
        await bb.storage.kv.delete(PINS_KEY);
        bb.realtime.publish(PINS_CHANGED, {});
        return { exitCode: 0, stdout: "The row shows the catalog's pinned tags again." };
      }
      if (command === "remove-own" && args.length === 1) {
        const current = await readOwn();
        const next = current.filter((scenario) => scenario.id !== args[0]);
        if (next.length === current.length) return { exitCode: 1, stderr: `No own scenario with id ${args[0]}. Run "bb scenario-tags check" to see ids.` };
        await writeOwn(next);
        return { exitCode: 0, stdout: `Deleted ${args[0]}.` };
      }
      if (command === "unhide" && args.length === 1) {
        const before = await readCuration();
        const ids = args[0] === "--all" ? before.hidden : args.filter((id) => before.hidden.includes(id));
        if (ids.length === 0) {
          return args[0] === "--all"
            ? { exitCode: 0, stdout: "Nothing is hidden." }
            : { exitCode: 1, stderr: `${args[0]} is not hidden. Run "bb scenario-tags check" to see what is.` };
        }
        await updateCuration({ unhide: ids });
        return { exitCode: 0, stdout: `Shown again: ${ids.join(", ")}.` };
      }
      if (command === undefined || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      return { exitCode: 1, stderr: usage };
    },
  });
}
