// The build manifest: the single description of what every client should run.
//
// The structure mirrors the manifest JSON Schema kept next to the manifest.
// Fleet Kit refuses to apply a manifest with errors and applies one with
// warnings. Fields this Fleet Kit does not know at the root and in `plugins[]`
// are warnings, not errors, so a manifest written for a newer Fleet Kit can
// still deliver that newer Fleet Kit (see readSelfEntry).
//
// The manifest decides which code runs on every client, so the client limits
// what it may ask for: plugins come from `git:https://` sources only (local
// sources need the machine's own `allowDevSources` setting), the OpenCode
// block may set only providers and models, `{secret:...}` may appear only in a
// provider's key or headers, and OpenCode's own `{env:...}` / `{file:...}`
// substitutions are refused everywhere.
import { z } from "zod";

/** The newest manifest format this Fleet Kit understands. */
export const SUPPORTED_SCHEMA = 1;
export const SELF_ID = "fleet-kit";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes");
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "use an exact version such as 1.2.3");
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const modelRef = z.string().regex(/^[a-z0-9][a-z0-9-]*\/\S+$/, "use <provider>/<model>");
const pluginSource = z
  .string()
  .regex(/^(git|npm|path|builtin):\S.*$/, "use a bb plugin source: git:, npm:, path: or builtin:");

const pluginShape = {
  id,
  source: pluginSource.nullable(),
  plugin: id.optional(),
  subdirectory: z.string().min(1).optional(),
  config: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), scalar).optional(),
  status: z.enum(["required", "planned"]),
  note: z.string().optional(),
};

const pluginEntry = z
  .object(pluginShape)
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.status === "required" && entry.source === null) {
      ctx.addIssue({ code: "custom", path: ["source"], message: "a required plugin needs a source" });
    }
    // bb names an installed plugin by its own id; Fleet Kit tracks plugins by
    // the manifest id, so the two must be the same plugin.
    if (entry.plugin !== undefined && entry.plugin !== entry.id) {
      ctx.addIssue({ code: "custom", path: ["plugin"], message: `must equal the id "${entry.id}"` });
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

/** The only top-level OpenCode keys a build may set. */
export const OPENCODE_KEYS = ["providers", "model", "small_model", "update"] as const;

const opencodeBlock = z
  .object({
    providers: z.record(id, providerBlock).refine((value) => Object.keys(value).length > 0, "declare at least one provider"),
    model: modelRef,
    small_model: modelRef.optional(),
    update: z.union([z.string(), z.boolean()]).optional(),
  })
  .strict();

const rootShape = {
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
};

export const manifestSchema = z.object(rootShape).strict();

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestPlugin = Manifest["plugins"][number];

export interface CheckOptions {
  /** This machine's `allowDevSources` setting: path:, npm: and local git sources, loopback gateways. */
  allowDevSources?: boolean;
}

export interface ManifestCheck {
  manifest: Manifest | null;
  errors: string[];
  warnings: string[];
  /** The manifest uses a newer format than this Fleet Kit understands. */
  newerFormat: boolean;
}

const SECRET_REF = /\{secret:([^}]*)\}/g;
// OpenCode expands {env:...} and {file:...} itself: through a manifest's
// baseURL a client's variable or file would leave the machine.
const OPENCODE_SUBSTITUTION = /\{(env|file):[^}]*\}/;

function strings(value: unknown, path: string[], out: { value: string; path: string[] }[] = []) {
  if (typeof value === "string") out.push({ value, path });
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, [...path, String(index)], out));
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) strings(item, [...path, key], out);
  }
  return out;
}

/** Every object key, with its path: OpenCode substitutes inside keys too. */
function keys(value: unknown, path: string[], out: { value: string; path: string[] }[] = []) {
  if (Array.isArray(value)) value.forEach((item, index) => keys(item, [...path, String(index)], out));
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push({ value: key, path: [...path, key] });
      keys(item, [...path, key], out);
    }
  }
  return out;
}

/** Every `{secret:name}` reference in a JSON value, with its JSON path. */
export function secretRefs(value: unknown, path: string[] = []): { name: string; path: string[] }[] {
  return strings(value, path).flatMap((entry) => [...entry.value.matchAll(SECRET_REF)].map((match) => ({ name: match[1] ?? "", path: entry.path })));
}

/** `{secret:...}` belongs only in a provider's whole `settings.apiKey` or in `settings.headers.<H>`. */
function secretAllowedAt(path: string[], value: string): boolean {
  const [root, providers, , settings, field, header, ...rest] = path;
  if (root !== "opencode" || providers !== "providers" || settings !== "settings") return false;
  if (field === "apiKey") return path.length === 5 && /^\{secret:[a-z0-9][a-z0-9-]*\}$/.test(value);
  return field === "headers" && typeof header === "string" && rest.length === 0;
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

/** Why a plugin source is not allowed on this machine, or null. */
export function sourceProblem(source: string, allowDevSources = false): string | null {
  if (/^git:https:\/\/\S/.test(source)) return null;
  if (source.startsWith("builtin:")) return "plugins bundled with bb are not installed from a manifest";
  if (allowDevSources && /^(git|path|npm):\S/.test(source)) return null;
  return "use a git:https:// source; path:, npm: and local git sources need allowDevSources on this machine";
}

/** Fleet Kit updates itself only from a source pinned to releases or to a named ref. */
export function selfSourcePinned(source: string): boolean {
  return /@(semver|ref):\S/.test(source);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** OpenCode installs a provider's `package` from npm; a build may name only OpenCode's own providers. */
export function providerPackageProblem(value: unknown, allowDevSources = false): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return "package must be a string";
  if (/^@opencode\/ai\/providers\/[a-z0-9][a-z0-9-]*$/.test(value)) return null;
  if (allowDevSources) return null;
  return `package "${value}" is not an OpenCode provider (@opencode/ai/providers/...); other packages need allowDevSources on this machine`;
}

/** Why a provider address may not receive a build key, or null. */
export function baseUrlProblem(value: unknown, allowDevSources = false): string | null {
  if (typeof value !== "string") return "settings.baseURL is required for a provider that uses a {secret:...}";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "settings.baseURL is not a valid URL";
  }
  if (url.username || url.password) return "settings.baseURL must not carry credentials";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) {
    return allowDevSources ? null : "an http://localhost gateway is allowed only with allowDevSources on this machine";
  }
  return "settings.baseURL must be an https:// address";
}

/** The `fleet-kit` entry, read from raw JSON before any other check. */
export function readSelfEntry(raw: unknown): { source: string } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const plugins = (raw as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return null;
  const entry = plugins.find((item) => item !== null && typeof item === "object" && (item as { id?: unknown }).id === SELF_ID) as
    | { source?: unknown; status?: unknown; plugin?: unknown }
    | undefined;
  if (entry === undefined || typeof entry.source !== "string" || entry.status !== "required") return null;
  if (entry.plugin !== undefined && entry.plugin !== SELF_ID) return null;
  return { source: entry.source };
}

/** Drop fields this Fleet Kit does not know at the root and in plugins[]; each one is a warning. */
function dropUnknownFields(raw: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key in rootShape) copy[key] = value;
    else warnings.push(`${key}: not known to this Fleet Kit; ignored`);
  }
  if (Array.isArray(copy.plugins)) {
    copy.plugins = copy.plugins.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (key in pluginShape) kept[key] = value;
        else warnings.push(`plugins.${index}.${key}: not known to this Fleet Kit; ignored`);
      }
      return kept;
    });
  }
  return copy;
}

/** Structural check plus the cross-section rules a JSON Schema cannot express. */
export function checkManifest(raw: unknown, options: CheckOptions = {}): ManifestCheck {
  const allowDev = options.allowDevSources === true;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { manifest: null, errors: ["(root): the manifest must be a JSON object"], warnings, newerFormat: false };
  }
  const declaredFormat = (raw as { schema?: unknown }).schema;
  if (typeof declaredFormat === "number" && declaredFormat > SUPPORTED_SCHEMA) {
    return {
      manifest: null,
      errors: [`The manifest uses format ${declaredFormat}; this Fleet Kit understands format ${SUPPORTED_SCHEMA}. Update Fleet Kit.`],
      warnings,
      newerFormat: true,
    };
  }
  const parsed = manifestSchema.safeParse(dropUnknownFields(raw as Record<string, unknown>, warnings));
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 50)) {
      const where = issue.path.length ? issue.path.join(".") : "(root)";
      errors.push(`${where}: ${issue.message}`);
    }
    return { manifest: null, errors, warnings, newerFormat: false };
  }
  const manifest = parsed.data;
  if (manifest.schema !== SUPPORTED_SCHEMA) errors.push(`schema: format ${manifest.schema} is not supported`);

  for (const { value, path } of strings(manifest, [])) {
    if (OPENCODE_SUBSTITUTION.test(value)) {
      errors.push(`${path.join(".")}: {env:...} and {file:...} are not allowed; OpenCode would send the client's value to the manifest's address`);
    }
    if (/\{secret:/.test(value) && !secretAllowedAt(path, value)) {
      errors.push(`${path.join(".")}: {secret:...} is allowed only as a provider's whole settings.apiKey or in settings.headers`);
    }
  }
  for (const { value, path } of keys(manifest, [])) {
    if (OPENCODE_SUBSTITUTION.test(value) || /\{secret:/.test(value)) {
      errors.push(`${path.join(".")}: substitutions such as {env:...}, {file:...} and {secret:...} are not allowed in names`);
    }
  }

  const ids = new Set<string>();
  for (const [index, entry] of manifest.plugins.entries()) {
    if (ids.has(entry.id)) errors.push(`plugins: "${entry.id}" is listed twice`);
    ids.add(entry.id);
    if (entry.source !== null) {
      const problem = sourceProblem(entry.source, allowDev);
      if (problem !== null) errors.push(`plugins.${index}.source: ${problem}`);
    }
  }
  const self = manifest.plugins.find((entry) => entry.id === SELF_ID);
  if (self === undefined || self.status !== "required") errors.push(`plugins: "${SELF_ID}" must be listed with status "required"`);
  else if (self.source !== null && !selfSourcePinned(self.source)) {
    warnings.push(`plugins: Fleet Kit updates itself only from a source pinned with @semver:<range> or @ref:<name>`);
  }
  for (const removed of manifest.removePlugins ?? []) {
    if (ids.has(removed)) errors.push(`removePlugins: "${removed}" is also listed in plugins`);
    if (removed === SELF_ID) errors.push(`removePlugins: Fleet Kit cannot remove itself`);
  }
  for (const server of manifest.mcp) {
    if (server.type === "plugin" && (server.plugin === undefined || !ids.has(server.plugin))) {
      errors.push(`mcp.${server.id}: refers to a plugin that is not in plugins`);
    }
    if (server.type === "remote" && (server.url === null || server.url === undefined)) {
      warnings.push(`mcp.${server.id}: no address yet`);
    }
  }

  const declaredSecrets = new Set(manifest.secrets.map((secret) => secret.name));
  for (const ref of secretRefs(manifest.opencode, ["opencode"])) {
    if (!declaredSecrets.has(ref.name)) errors.push(`${ref.path.join(".")}: {secret:${ref.name}} is not declared in secrets`);
  }

  const allowed = new Set(manifest.allowedProviders);
  for (const [providerId, provider] of Object.entries(manifest.opencode.providers)) {
    if (!allowed.has(providerId)) errors.push(`opencode.providers.${providerId}: not in allowedProviders`);
    const packageProblem = providerPackageProblem(provider.package, allowDev);
    if (packageProblem !== null) errors.push(`opencode.providers.${providerId}: ${packageProblem}`);
    const settings = provider.settings ?? {};
    const usesSecret = secretRefs(settings).length > 0;
    if (usesSecret || settings.baseURL !== undefined) {
      const problem = baseUrlProblem(settings.baseURL, allowDev);
      if (problem !== null) errors.push(`opencode.providers.${providerId}: ${problem}`);
    }
  }
  for (const key of ["model", "small_model"] as const) {
    const value = manifest.opencode[key];
    if (value === undefined) continue;
    const provider = value.split("/")[0]!;
    if (!allowed.has(provider)) errors.push(`opencode.${key}: provider "${provider}" is not in allowedProviders`);
    if (!(provider in manifest.opencode.providers)) {
      warnings.push(`opencode.${key}: provider "${provider}" is not declared in opencode.providers`);
    }
  }
  if (compareVersions(manifest.install.bb, manifest.bb.minVersion) < 0) {
    errors.push("install.bb: lower than bb.minVersion");
  }
  if (/-/.test(manifest.version)) warnings.push(`version: ${manifest.version} is a pre-release`);
  return { manifest: errors.length === 0 ? manifest : null, errors, warnings, newerFormat: false };
}
