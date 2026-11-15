// The scenario catalog: what the tags above the message box offer.
//
// The catalog arrives as one JSON string in the `scenarios` setting (a build
// manifest or the person writes it). Parsing is lenient per entry: a broken
// scenario is skipped and reported, the rest still show. Everything here is
// plain functions shared by the server (the CLI check) and the frontend.
import { z } from "zod";

export const MAX_CATALOG_CHARS = 200_000;
const MAX_SCENARIOS = 200;
const MAX_FIELDS = 12;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "letters, digits, _ . - (up to 64)");
const label = z.string().trim().min(1).max(60);
const text = (max: number) => z.string().max(max);

export const fieldSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    id,
    label: text(120).pipe(z.string().trim().min(1)),
    required: z.boolean().optional(),
    placeholder: text(200).optional(),
    hint: text(300).optional(),
    default: text(500).optional(),
  }),
  z.object({
    type: z.literal("textarea"),
    id,
    label: text(120).pipe(z.string().trim().min(1)),
    required: z.boolean().optional(),
    placeholder: text(300).optional(),
    hint: text(300).optional(),
    default: text(4000).optional(),
  }),
  z.object({
    type: z.literal("select"),
    id,
    label: text(120).pipe(z.string().trim().min(1)),
    required: z.boolean().optional(),
    options: z.array(text(120).pipe(z.string().trim().min(1))).min(1).max(30),
    hint: text(300).optional(),
    default: text(120).optional(),
  }),
  z.object({
    // A file the person attaches to the message itself (the composer's + or a drop).
    type: z.literal("attachment"),
    id,
    label: text(120).pipe(z.string().trim().min(1)),
    required: z.boolean().optional(),
    hint: text(300).optional(),
    /** What `{{id}}` becomes in the prompt once a file is attached. */
    answer: text(200).optional(),
  }),
]);
export type ScenarioField = z.infer<typeof fieldSchema>;

const scenarioSchema = z.object({
  id,
  label,
  group: id.optional(),
  description: text(300).optional(),
  /** Shown in the collapsed row until the person picks their own tags. */
  pinned: z.boolean().optional(),
  fields: z.array(fieldSchema).max(MAX_FIELDS).optional(),
  /** The text put into the message box; `{{field}}` takes an answer, `{{answers}}` lists the rest. */
  prompt: text(8000).optional(),
});
export type Scenario = Omit<z.infer<typeof scenarioSchema>, "fields"> & { fields: ScenarioField[] };

const groupSchema = z.object({ id, label });
export type ScenarioGroup = z.infer<typeof groupSchema>;

export type Catalog = {
  groups: ScenarioGroup[];
  scenarios: Scenario[];
  /** Entries left out, with the reason; shown by `bb scenario-tags check`. */
  problems: string[];
};

export const EMPTY_CATALOG: Catalog = { groups: [], scenarios: [], problems: [] };

function issueText(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
    .join("; ");
}

/** One scenario against the schema and its own rules: unique fields, known placeholders. */
export function checkScenario(entry: unknown): { scenario: Scenario } | { problem: string } {
  const parsed = scenarioSchema.safeParse(entry);
  if (!parsed.success) return { problem: issueText(parsed.error) };
  const scenario: Scenario = { ...parsed.data, fields: parsed.data.fields ?? [] };
  const fieldIds = new Set<string>();
  const repeated = scenario.fields.find((field) => (fieldIds.has(field.id) ? true : (fieldIds.add(field.id), false)));
  if (repeated) return { problem: `the field id "${repeated.id}" repeats` };
  if (fieldIds.has("answers")) return { problem: `"answers" is reserved for the list of answers` };
  const unknown = placeholders(scenario.prompt ?? "").filter((name) => name !== "answers" && !fieldIds.has(name));
  if (unknown.length > 0) return { problem: `the prompt uses {{${unknown[0]}}}, which is not a field` };
  return { scenario };
}

/** Reads the `scenarios` setting. Never throws: problems come back as text. */
export function parseCatalog(raw: string | undefined | null): Catalog {
  const source = (raw ?? "").trim();
  if (source === "") return EMPTY_CATALOG;
  if (source.length > MAX_CATALOG_CHARS) {
    return { ...EMPTY_CATALOG, problems: [`The catalog is longer than ${MAX_CATALOG_CHARS} characters.`] };
  }
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return { ...EMPTY_CATALOG, problems: [`The catalog is not JSON: ${(error as Error).message}`] };
  }
  // A bare array is a catalog without groups.
  const root = Array.isArray(data) ? { scenarios: data } : data;
  if (root === null || typeof root !== "object") {
    return { ...EMPTY_CATALOG, problems: ["The catalog must be an object with `scenarios`."] };
  }
  const problems: string[] = [];
  const record = root as Record<string, unknown>;

  const groups: ScenarioGroup[] = [];
  const groupIds = new Set<string>();
  for (const [index, entry] of (Array.isArray(record.groups) ? record.groups : []).entries()) {
    const parsed = groupSchema.safeParse(entry);
    if (!parsed.success) problems.push(`groups[${index}]: ${issueText(parsed.error)}`);
    else if (groupIds.has(parsed.data.id)) problems.push(`groups[${index}]: the id "${parsed.data.id}" repeats`);
    else {
      groupIds.add(parsed.data.id);
      groups.push(parsed.data);
    }
  }

  const scenarios: Scenario[] = [];
  const scenarioIds = new Set<string>();
  const entries = Array.isArray(record.scenarios) ? record.scenarios : [];
  if (!Array.isArray(record.scenarios)) problems.push("The catalog has no `scenarios` list.");
  for (const [index, entry] of entries.slice(0, MAX_SCENARIOS).entries()) {
    const checked = checkScenario(entry);
    if ("problem" in checked) {
      const name = entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? ` (${(entry as { id: string }).id})` : "";
      problems.push(`scenarios[${index}]${name}: ${checked.problem}`);
      continue;
    }
    const { scenario } = checked;
    if (scenarioIds.has(scenario.id)) {
      problems.push(`scenarios[${index}] (${scenario.id}): the id repeats`);
      continue;
    }
    if (scenario.group && !groupIds.has(scenario.group)) {
      // An undeclared group still works: it is named after its id.
      groupIds.add(scenario.group);
      groups.push({ id: scenario.group, label: scenario.group });
    }
    scenarioIds.add(scenario.id);
    scenarios.push(scenario);
  }
  if (entries.length > MAX_SCENARIOS) problems.push(`Only the first ${MAX_SCENARIOS} scenarios are used.`);
  return { groups, scenarios, problems };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/**
 * The person's own pick for the collapsed row. `known` lists the catalog's
 * default pins at the time of the pick: a default added to the catalog later
 * still joins the row, so a new tag reaches everyone with the next release.
 */
export type OwnPins = { pins: string[]; known: string[] };

const defaultPins = (catalog: Catalog) => catalog.scenarios.filter((scenario) => scenario.pinned).map((scenario) => scenario.id);

/** The scenarios of the collapsed row: the person's own pick, else the catalog's. */
export function pinnedScenarios(catalog: Catalog, own: OwnPins | null): Scenario[] {
  if (own === null) return catalog.scenarios.filter((scenario) => scenario.pinned);
  const ids = [...own.pins, ...defaultPins(catalog).filter((id) => !own.known.includes(id) && !own.pins.includes(id))];
  const byId = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  return ids.map((scenarioId) => byId.get(scenarioId)).filter((scenario): scenario is Scenario => scenario !== undefined);
}

/** Scenarios by group in catalog order; ungrouped ones come last under `null`. */
export function groupedScenarios(catalog: Catalog): Array<{ group: ScenarioGroup | null; scenarios: Scenario[] }> {
  const sections = catalog.groups
    .map((group) => ({ group: group as ScenarioGroup | null, scenarios: catalog.scenarios.filter((s) => s.group === group.id) }))
    .filter((section) => section.scenarios.length > 0);
  const rest = catalog.scenarios.filter((scenario) => !scenario.group);
  if (rest.length > 0) sections.push({ group: null, scenarios: rest });
  return sections;
}

/** Pins after the person toggles one scenario; starts from what the row shows now. */
export function togglePin(catalog: Catalog, own: OwnPins | null, scenarioId: string): OwnPins {
  const current = pinnedScenarios(catalog, own).map((scenario) => scenario.id);
  const pins = current.includes(scenarioId) ? current.filter((item) => item !== scenarioId) : [...current, scenarioId];
  const known = [...new Set([...(own?.known ?? []), ...defaultPins(catalog)])];
  return { pins, known };
}

export type Answers = Record<string, string>;

export function initialAnswers(scenario: Scenario): Answers {
  const answers: Answers = {};
  for (const field of scenario.fields) {
    if (field.type !== "attachment") answers[field.id] = field.default ?? "";
  }
  return answers;
}

/** Required fields still without an answer; an attachment needs a file on the message. */
export function missingFields(scenario: Scenario, answers: Answers, attachmentCount: number): ScenarioField[] {
  return scenario.fields.filter((field) => {
    if (!field.required) return false;
    if (field.type === "attachment") return attachmentCount < 1;
    return (answers[field.id] ?? "").trim() === "";
  });
}

/** The value `{{field}}` takes: the trimmed answer, or for an attachment its `answer` text once a file is there. */
function fieldValue(field: ScenarioField, answers: Answers, attachmentCount: number, attachedText: string): string {
  if (field.type === "attachment") return attachmentCount > 0 ? field.answer ?? attachedText : "";
  return (answers[field.id] ?? "").trim();
}

/**
 * The text for the message box. A template line whose placeholders are all
 * empty is dropped, so `Period: {{period}}` disappears when the period is
 * left out. Without a template the prompt is the list of answers.
 */
export function renderPrompt(
  scenario: Scenario,
  answers: Answers,
  attachmentCount: number,
  attachedText = "attached to this message",
): string {
  const values = new Map(scenario.fields.map((field) => [field.id, fieldValue(field, answers, attachmentCount, attachedText)]));
  const template = scenario.prompt ?? "{{answers}}";
  const used = new Set(placeholders(template));
  const listed = scenario.fields
    .filter((field) => !used.has(field.id))
    .map((field) => ({ field, value: values.get(field.id) ?? "" }))
    .filter(({ value }) => value !== "")
    .map(({ field, value }) => (value.includes("\n") ? `${field.label}:\n${value}` : `${field.label}: ${value}`))
    .join("\n");
  values.set("answers", listed);

  const lines: string[] = [];
  for (const line of template.split("\n")) {
    const names = placeholders(line);
    if (names.length > 0 && names.every((name) => (values.get(name) ?? "") === "")) continue;
    lines.push(line.replace(PLACEHOLDER, (_, name: string) => values.get(name) ?? ""));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- The person's own scenarios ----------

/** The group own scenarios show under; its label comes from the interface language. */
export const MINE_GROUP = "mine-own";
export const MAX_OWN = 50;
export const OWN_PREFIX = "my-";

export const isOwn = (scenario: Scenario) => scenario.group === MINE_GROUP;

/** Own scenarios first, under their own group; a catalog entry with the same id gives way. */
export function withOwn(catalog: Catalog, own: readonly Scenario[], mineLabel: string): Catalog {
  if (own.length === 0) return catalog;
  const ownIds = new Set(own.map((scenario) => scenario.id));
  return {
    groups: [{ id: MINE_GROUP, label: mineLabel }, ...catalog.groups.filter((group) => group.id !== MINE_GROUP)],
    scenarios: [...own.map((scenario) => ({ ...scenario, group: MINE_GROUP, pinned: false })), ...catalog.scenarios.filter((s) => !ownIds.has(s.id))],
    problems: catalog.problems,
  };
}

/** A scenario as the catalog file has it, for "suggest to everyone". */
export function catalogEntry(scenario: Scenario, keepId = false): Record<string, unknown> {
  const { group: _group, pinned: _pinned, ...rest } = scenario;
  const shortId = scenario.id.startsWith(OWN_PREFIX) ? scenario.id.slice(OWN_PREFIX.length) : scenario.id;
  const entry: Record<string, unknown> = { ...rest, id: keepId ? scenario.id : shortId };
  if (scenario.fields.length === 0) delete entry.fields;
  return entry;
}

/** Fills `{{label}}`, `{{id}}` and `{{scenario}}` in the edit prompt. */
export function editPrompt(template: string, scenario: Scenario): string {
  const json = JSON.stringify(catalogEntry(scenario, true), null, 2);
  const values: Record<string, string> = { label: scenario.label, id: scenario.id, scenario: json };
  return template.replace(PLACEHOLDER, (match, name: string) => values[name] ?? match);
}
