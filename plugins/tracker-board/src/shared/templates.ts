// Templates for child issues. A template is a blank child: a title prefix, a type,
// labels, components, an assignee and a priority. The title comes from the parent:
// under the story "Saved cards" the template [BE] creates "[BE] Saved cards".
// A bundle creates several at once, for example a story with five tasks under it.
// The build brings its templates and bundles; a person adds their own on top.
import { z } from "zod";
import { LIMITS } from "./limits";
import { splitPrefix, type Issue, type Kind } from "./model";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/);

export const templateSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(100),
    /** `[BE]`; empty for no prefix. */
    prefix: z.string().max(20).default(""),
    /** The tracker's type key; empty uses the first configured type. */
    type: z.string().max(100).default(""),
    under: z.enum(["epic", "story", "any"]).default("any"),
    /** `{Q}` is the quarter (1–4), `{YY}` and `{YYYY}` the year. */
    labels: z.array(z.string().min(1).max(LIMITS.label)).max(LIMITS.labels).default([]),
    components: z.array(z.string().min(1).max(200)).max(20).default([]),
    /** Empty for nobody, `@me` for whoever creates, `@parent` for the parent's assignee, or a person's id. */
    assignee: z.string().max(200).default(""),
    /** Empty for the tracker's default, `inherit` for the parent's, or a priority key. */
    priority: z.string().max(100).default(""),
    description: z.string().max(10_000).default(""),
  })
  .strict();
export type Template = z.infer<typeof templateSchema> & { own?: boolean };

export const bundleSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(100),
    under: z.enum(["epic", "story", "any"]).default("any"),
    items: z
      .array(z.object({ template: idSchema, children: z.array(idSchema).max(20).default([]) }).strict())
      .min(1)
      .max(20),
  })
  .strict();
export type Bundle = z.infer<typeof bundleSchema>;

export const templatesConfigSchema = z
  .object({
    templates: z.array(templateSchema).max(LIMITS.templates).default([]),
    bundles: z.array(bundleSchema).max(30).default([]),
    /** Templates whose tiles a story card shows; defaults to every build template under stories. */
    composition: z.array(idSchema).max(12).optional(),
  })
  .strict();
export type TemplatesConfig = z.infer<typeof templatesConfigSchema>;

export class TemplatesError extends Error {}

export function parseTemplates(text: string): TemplatesConfig {
  if (text.trim() === "") return { templates: [], bundles: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TemplatesError(`Templates are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = templatesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TemplatesError(`Templates are invalid at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown problem"}`);
  }
  const ids = new Set<string>();
  for (const template of parsed.data.templates) {
    if (ids.has(template.id)) throw new TemplatesError(`Template ${template.id} is defined twice`);
    ids.add(template.id);
  }
  for (const bundle of parsed.data.bundles) {
    for (const item of bundle.items) {
      for (const id of [item.template, ...item.children]) if (!ids.has(id)) throw new TemplatesError(`Bundle ${bundle.id} names an unknown template ${id}`);
    }
  }
  return parsed.data;
}

/** Build templates first; a person's own template with a build id is skipped. */
export function mergeTemplates(build: readonly Template[], own: readonly Template[]): Template[] {
  const ids = new Set(build.map((template) => template.id));
  return [...build.map((template) => ({ ...template, own: false })), ...own.filter((template) => !ids.has(template.id)).map((template) => ({ ...template, own: true }))];
}

export function compositionOf(config: TemplatesConfig): string[] {
  return config.composition ?? config.templates.filter((template) => template.under === "story").map((template) => template.id);
}

/** `TEAM-QA-Q{Q}{YY}` on 7 Nov 2026 → `TEAM-QA-Q426`. */
export function expandLabel(label: string, now: Date): string {
  const year = now.getFullYear();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  return label.replaceAll("{Q}", String(quarter)).replaceAll("{YYYY}", String(year)).replaceAll("{YY}", String(year % 100).padStart(2, "0"));
}

export function prefixId(template: Template): string {
  return splitPrefix(template.prefix.trim() + " x").prefix;
}

export function childTitle(template: Template, parentSummary: string): string {
  const base = splitPrefix(parentSummary).rest.trim();
  const prefix = template.prefix.trim();
  return (prefix ? `${prefix} ${base}` : base).slice(0, LIMITS.summary);
}

/** The template a child issue was made from, by its title prefix. */
export function templateOfIssue(issue: Issue, templates: readonly Template[]): Template | null {
  const { prefix } = splitPrefix(issue.summary);
  if (!prefix) return null;
  return templates.find((template) => prefixId(template).toLowerCase() === prefix.toLowerCase()) ?? null;
}

export function fits(template: Template | Bundle, parentKind: Kind): boolean {
  return template.under === "any" || template.under === parentKind;
}

export interface PlanRow {
  /** Row id inside the plan. */
  ref: string;
  template: string;
  title: string;
  type: string;
  assignee: string;
  priority: string;
  labels: string[];
  components: string[];
  description: string;
  /** The existing issue it goes under, or null when it goes under a row created earlier in this plan. */
  parentKey: string | null;
  /** The row of this plan it goes under. */
  parentRef: string | null;
  /** An existing child made from this template: nothing is created for it. */
  exists: string | null;
}

export interface PlanContext {
  parent: Issue;
  children: readonly Issue[];
  templates: readonly Template[];
  now: Date;
  defaultType: string;
}

function row(ctx: PlanContext, template: Template, parentSummary: string, parent: { key: string } | { ref: string }, ref: string, exists: string | null): PlanRow {
  return {
    ref,
    template: template.id,
    title: childTitle(template, parentSummary),
    type: template.type || ctx.defaultType,
    assignee: template.assignee,
    priority: template.priority === "inherit" ? ctx.parent.priority ?? "" : template.priority,
    labels: template.labels.map((label) => expandLabel(label, ctx.now)),
    components: [...template.components],
    description: template.description,
    parentKey: "key" in parent ? parent.key : null,
    parentRef: "ref" in parent ? parent.ref : null,
    exists,
  };
}

/**
 * The rows a bundle (or a plain list of templates) would create under a parent.
 * A template already used by a child of the parent is marked as existing.
 */
export function planRows(ctx: PlanContext, items: readonly { template: string; children?: readonly string[] }[]): PlanRow[] {
  const byId = new Map(ctx.templates.map((template) => [template.id, template]));
  const existing = (template: Template) =>
    ctx.children.find((child) => splitPrefix(child.summary).prefix.toLowerCase() === prefixId(template).toLowerCase() && prefixId(template) !== "")?.key ?? null;
  const rows: PlanRow[] = [];
  let n = 0;
  for (const item of items) {
    const template = byId.get(item.template);
    if (!template) continue;
    const ref = `r${++n}`;
    const exists = existing(template);
    rows.push(row(ctx, template, ctx.parent.summary, { key: ctx.parent.key }, ref, exists));
    for (const childId of item.children ?? []) {
      const child = byId.get(childId);
      if (!child) continue;
      // Children of an existing row go under that issue; it may already have them, which the server checks.
      rows.push(row(ctx, child, ctx.parent.summary, exists ? { key: exists } : { ref }, `r${++n}`, null));
    }
  }
  return rows;
}
