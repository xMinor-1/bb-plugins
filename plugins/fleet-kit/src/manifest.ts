// The build manifest: the single description of what every client should run.
//
// The structure mirrors the manifest JSON Schema kept next to the manifest
// (strict root, `bb`, `plugins[]`, `secrets[]`, `mcp[]`; free-form `opencode`
// and plugin `config`). Fleet Kit refuses to apply a manifest with errors and
// applies one with warnings.
import { z } from "zod";

/** The newest manifest format this Fleet Kit understands. */
export const SUPPORTED_SCHEMA = 1;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes");
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "use an exact version such as 1.2.3");
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const pluginSource = z
  .string()
  .regex(/^(git|npm|path|builtin):\S.*$/, "use a bb plugin source: git:, npm:, path: or builtin:");

const pluginEntry = z
  .object({
    id,
    source: pluginSource.nullable(),
    plugin: id.optional(),
    subdirectory: z.string().min(1).optional(),
    config: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), scalar).optional(),
    status: z.enum(["required", "planned"]),
    note: z.string().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.status === "required" && entry.source === null) {
      ctx.addIssue({ code: "custom", path: ["source"], message: "a required plugin needs a source" });
    }
  });

const mcpEntry = z
  .object({
    id,
    title: z.string().min(1),
    type: z.enum(["remote", "plugin", "local"]),
    url: z.string().nullable().optional(),
    plugin: id.optional(),
    auth: z.string().optional(),
    default: z.boolean(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const providerBlock = z
  .object({
    name: z.string().min(1).optional(),
    package: z.string().min(1).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    models: z.record(z.string(), z.record(z.string(), z.unknown())).refine((value) => Object.keys(value).length > 0, "list at least one model"),
  })
  .passthrough();

const opencodeBlock = z
  .object({
    providers: z.record(id, providerBlock).refine((value) => Object.keys(value).length > 0, "declare at least one provider"),
    model: z.string().regex(/^[a-z0-9][a-z0-9-]*\/\S+$/, "use <provider>/<model>"),
  })
  .passthrough();

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    schema: z.number().int().positive(),
    name: z.string().min(1),
    version: z.string().min(1),
    install: z.object({ bb: exactVersion, opencode: exactVersion }).strict(),
    bb: z
      .object({
        minVersion: exactVersion,
        settings: z.record(z.string().regex(/^[a-z][A-Za-z0-9]*$/), scalar).optional(),
      })
      .strict(),
    marketplaces: z
      .array(z.object({ source: z.string().min(1), subdirectory: z.string().min(1).optional() }).strict())
      .optional(),
    plugins: z.array(pluginEntry),
    removePlugins: z.array(id).optional(),
    secrets: z.array(z.object({ name: id, title: z.string().min(1), hint: z.string().optional() }).strict()),
    allowedProviders: z.array(id).min(1),
    opencode: opencodeBlock,
    mcp: z.array(mcpEntry),
    skills: z.array(z.object({ id }).passthrough()).optional(),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestPlugin = Manifest["plugins"][number];

export interface ManifestCheck {
  manifest: Manifest | null;
  errors: string[];
  warnings: string[];
}

const SECRET_REF = /\{secret:([^}]*)\}/g;

/** Every `{secret:name}` reference in a JSON value, with its JSON path. */
export function secretRefs(value: unknown, path: string[] = []): { name: string; path: string[] }[] {
  if (typeof value === "string") {
    return [...value.matchAll(SECRET_REF)].map((match) => ({ name: match[1] ?? "", path }));
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => secretRefs(item, [...path, String(index)]));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => secretRefs(item, [...path, key]));
  }
  return [];
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split("-")[0]!.split(".").map((part) => Number(part));
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export { compareVersions };

/** Structural check plus the cross-section rules a JSON Schema cannot express. */
export function checkManifest(raw: unknown): ManifestCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const declared = (raw as { schema?: unknown }).schema;
    if (typeof declared === "number" && declared > SUPPORTED_SCHEMA) {
      return {
        manifest: null,
        errors: [`The manifest uses format ${declared}; this Fleet Kit understands format ${SUPPORTED_SCHEMA}. Update Fleet Kit.`],
        warnings,
      };
    }
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 50)) {
      const where = issue.path.length ? issue.path.join(".") : "(root)";
      errors.push(`${where}: ${issue.message}`);
    }
    return { manifest: null, errors, warnings };
  }
  const manifest = parsed.data;
  if (manifest.schema !== SUPPORTED_SCHEMA) errors.push(`schema: format ${manifest.schema} is not supported`);

  const ids = new Set<string>();
  for (const entry of manifest.plugins) {
    if (ids.has(entry.id)) errors.push(`plugins: "${entry.id}" is listed twice`);
    ids.add(entry.id);
  }
  const self = manifest.plugins.find((entry) => entry.id === "fleet-kit");
  if (self === undefined || self.status !== "required") errors.push('plugins: "fleet-kit" must be listed with status "required"');
  for (const removed of manifest.removePlugins ?? []) {
    if (ids.has(removed)) errors.push(`removePlugins: "${removed}" is also listed in plugins`);
  }
  for (const server of manifest.mcp) {
    if (server.type === "plugin" && (server.plugin === undefined || !ids.has(server.plugin))) {
      errors.push(`mcp.${server.id}: refers to a plugin that is not in plugins`);
    }
    if (server.type === "remote" && (server.url === null || server.url === undefined)) {
      warnings.push(`mcp.${server.id}: no address yet`);
    }
  }

  const declared = new Set(manifest.secrets.map((secret) => secret.name));
  for (const ref of secretRefs({ opencode: manifest.opencode, plugins: manifest.plugins })) {
    if (!declared.has(ref.name)) errors.push(`${ref.path.join(".")}: {secret:${ref.name}} is not declared in secrets`);
  }

  const allowed = new Set(manifest.allowedProviders);
  for (const provider of Object.keys(manifest.opencode.providers)) {
    if (!allowed.has(provider)) errors.push(`opencode.providers.${provider}: not in allowedProviders`);
  }
  const defaultProvider = manifest.opencode.model.split("/")[0]!;
  if (!allowed.has(defaultProvider)) errors.push(`opencode.model: provider "${defaultProvider}" is not in allowedProviders`);
  if (!(defaultProvider in manifest.opencode.providers)) {
    warnings.push(`opencode.model: provider "${defaultProvider}" is not declared in opencode.providers`);
  }
  if (compareVersions(manifest.install.bb, manifest.bb.minVersion) < 0) {
    errors.push("install.bb: lower than bb.minVersion");
  }
  if (/-/.test(manifest.version)) warnings.push(`version: ${manifest.version} is a pre-release`);
  return { manifest: errors.length === 0 ? manifest : null, errors, warnings };
}
