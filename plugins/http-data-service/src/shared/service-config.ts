// What the plugin knows about the service comes from settings, not from code: the
// address, the methods with their parameters, and the guide agents read. A build
// keeps these in its own configuration, so this repository names no service.
import { z } from "zod";

const paramSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(100),
    type: z.enum(["string", "integer", "boolean", "date", "list"]),
    required: z.boolean().optional(),
    description: z.string().max(1000).default(""),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  })
  .strict();

const methodSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).max(100),
    /** Relative to the base address; never a full address, `..`, or a query string. */
    path: z
      .string()
      .regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/, "A method path is relative: letters, digits, _ and - between slashes")
      .max(300),
    summary: z.string().min(1).max(500),
    params: z.array(paramSchema).max(30).default([]),
    /** Long description, returned by the guide tool for this method only. */
    reference: z.string().max(50_000).default(""),
  })
  .strict();

const methodsSchema = z.array(methodSchema).max(100);

export type ServiceMethod = z.infer<typeof methodSchema>;
export type ServiceParam = z.infer<typeof paramSchema>;

export class ConfigError extends Error {}

export function parseMethods(text: string): ServiceMethod[] {
  if (text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError("The methods setting is not valid JSON");
  }
  const parsed = methodsSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(`The methods setting is invalid at ${first?.path.join(".") ?? "?"}: ${first?.message ?? "unknown"}`);
  }
  const names = new Set<string>();
  for (const method of parsed.data) {
    if (names.has(method.name)) throw new ConfigError(`The methods setting repeats "${method.name}"`);
    names.add(method.name);
  }
  return parsed.data;
}

const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** The base address with one trailing slash. https only (plain http just for this machine), no login and no query inside. */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError("The service address is not a valid address");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new ConfigError("The service address must start with https://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("The service address must not contain a login, a query or a fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/`;
}

/** The address of a method. A method path cannot leave the base address (see methodSchema). */
export function methodUrl(baseUrl: string, path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, normalizeBaseUrl(baseUrl));
  // encodeURIComponent, not URLSearchParams: its "+" for a space is read literally by some services.
  url.search = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return url.href;
}

/** The longest value of one parameter, the same limit the host contract enforces. */
export const MAX_QUERY_VALUE = 4000;

export type ParamValue = string | number | boolean | (string | number)[];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function queryValue(param: ServiceParam, value: ParamValue): string {
  const problem = (what: string) => new ConfigError(`Parameter "${param.name}": ${what}`);
  switch (param.type) {
    case "string":
      // A number has already lost its leading zeros, so it is refused rather than sent wrong.
      if (typeof value !== "string" || value.trim() === "") throw problem("pass a non-empty string");
      return value;
    case "integer": {
      const number = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (typeof number !== "number" || !Number.isSafeInteger(number)) throw problem("pass a whole number");
      if (param.min !== undefined && number < param.min) throw problem(`the minimum is ${param.min}`);
      if (param.max !== undefined && number > param.max) throw problem(`the maximum is ${param.max}`);
      return String(number);
    }
    case "boolean":
      if (typeof value === "boolean") return String(value);
      if (value === "true" || value === "false") return value;
      throw problem("pass true or false");
    case "date":
      if (typeof value !== "string" || !DATE.test(value)) throw problem("pass a date as YYYY-MM-DD");
      return value;
    case "list": {
      const items = Array.isArray(value) ? value : [value];
      if (items.length === 0 || items.some((item) => typeof item !== "string" || item.trim() === "")) {
        throw problem("pass a non-empty string or a list of non-empty strings");
      }
      // Values travel joined by commas, so one with a comma would arrive as two different values.
      if (items.some((item) => String(item).includes(","))) {
        throw problem("a value contains a comma, and the service separates values by commas. Pass several values as a list; a value that itself has a comma cannot be sent");
      }
      return items.map((item) => String(item).trim()).join(",");
    }
  }
}

/** The query of one call, or an error the agent can act on. Only declared parameters pass. */
export function buildQuery(method: ServiceMethod, params: Record<string, ParamValue> = {}): Record<string, string> {
  const query: Record<string, string> = {};
  for (const name of Object.keys(params)) {
    if (!method.params.some((param) => param.name === name)) {
      const known = method.params.map((param) => param.name).join(", ") || "none";
      throw new ConfigError(`Method "${method.name}" has no parameter "${name}". Its parameters: ${known}`);
    }
  }
  for (const param of method.params) {
    const value = params[param.name];
    if (value === undefined) {
      if (param.required) throw new ConfigError(`Method "${method.name}" needs the parameter "${param.name}"`);
      continue;
    }
    const text = queryValue(param, value);
    if (text.length > MAX_QUERY_VALUE) throw new ConfigError(`Parameter "${param.name}" is too long: narrow the request or make several calls`);
    query[param.name] = text;
  }
  return query;
}

function paramLine(param: ServiceParam): string {
  const range = [param.min !== undefined ? `min ${param.min}` : null, param.max !== undefined ? `max ${param.max}` : null].filter(Boolean).join(", ");
  const facts = [param.type, param.required ? "required" : "optional", range].filter(Boolean).join(", ");
  return `  - ${param.name} (${facts})${param.description ? `: ${param.description}` : ""}`;
}

export function methodsText(methods: readonly ServiceMethod[]): string {
  return methods
    .map((method) => [`- ${method.name}: ${method.summary}`, ...method.params.map(paramLine)].join("\n"))
    .join("\n");
}
