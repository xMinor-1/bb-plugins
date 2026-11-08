// Reading tracker answers and building tracker requests from the configuration.
//
// A field path is `a.b.c`; `a[].b` maps over an array; `x|y` tries `x`, then `y`.
// An empty path is the value itself. A request template is JSON whose strings may
// hold `{name}` placeholders: a string that is exactly one placeholder takes the
// variable's own type (an array stays an array), a missing variable drops the key
// or the array item, so one template serves "change only the priority" and
// "change everything".

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class TemplateError extends Error {}

function step(value: unknown, part: string): unknown[] {
  if (part.endsWith("[]")) {
    const name = part.slice(0, -2);
    const list = name === "" ? value : field(value, name);
    return Array.isArray(list) ? list : [];
  }
  return [field(value, part)];
}

function field(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.prototype.hasOwnProperty.call(value, name) ? (value as Record<string, unknown>)[name] : undefined;
}

function getOne(value: unknown, path: string): unknown {
  if (path === "") return value;
  const parts = path.split(".");
  let current: unknown[] = [value];
  let mapped = false;
  for (const part of parts) {
    if (part.endsWith("[]")) mapped = true;
    current = current.flatMap((item) => step(item, part));
  }
  if (mapped) return current.filter((item) => item !== undefined && item !== null);
  return current[0];
}

/** The first alternative that gives a value other than undefined or null. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  for (const alternative of path.split("|")) {
    const found = getOne(value, alternative.trim());
    if (found !== undefined && found !== null && !(Array.isArray(found) && found.length === 0 && path.includes("|"))) return found;
  }
  return undefined;
}

const ID_FIELDS = ["key", "value", "code", "id", "login"];
const NAME_FIELDS = ["display_name", "displayName", "display", "name", "title", "fullName", "full_name"];

/** A key-like value: a string or number as is, an object by its key, value, code or id. */
export function scalar(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const name of ID_FIELDS) {
      const inner = (value as Record<string, unknown>)[name];
      if (typeof inner === "string" || typeof inner === "number") return scalar(inner);
      if (inner && typeof inner === "object" && name === "key") return scalar(inner);
    }
  }
  return null;
}

/** A display name: a string as is, an object by its display name, name or title. */
export function displayName(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const name of NAME_FIELDS) {
      const inner = (value as Record<string, unknown>)[name];
      if (typeof inner === "string" && inner !== "") return inner;
    }
  }
  return null;
}

export function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

export function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const WHOLE = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/;
const OMIT = Symbol("omit");

export type Vars = Readonly<Record<string, Json | undefined>>;

function asText(value: Json): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map((item) => asText(item)).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fillString(template: string, vars: Vars): Json | typeof OMIT {
  const whole = WHOLE.exec(template);
  if (whole) {
    const value = vars[whole[1]!];
    return value === undefined ? OMIT : value;
  }
  let missing = false;
  const text = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      missing = true;
      return "";
    }
    return asText(value);
  });
  return missing ? OMIT : text;
}

function fillAny(template: Json, vars: Vars): Json | typeof OMIT {
  if (typeof template === "string") return fillString(template, vars);
  if (Array.isArray(template)) {
    const out: Json[] = [];
    for (const item of template) {
      const filled = fillAny(item, vars);
      if (filled !== OMIT) out.push(filled);
    }
    return out;
  }
  if (template && typeof template === "object") {
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(template)) {
      const filled = fillAny(value, vars);
      if (filled !== OMIT) out[key] = filled;
    }
    return out;
  }
  return template;
}

/** A request body from its template; a template whose every field is missing gives `{}`. */
export function fillJson(template: Json, vars: Vars): Json {
  const filled = fillAny(template, vars);
  return filled === OMIT ? null : filled;
}

/** A path from its template. Every placeholder is required and is percent-encoded. */
export function fillPath(template: string, vars: Vars): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null || value === "") throw new TemplateError(`The path ${template} needs {${name}}`);
    return encodeURIComponent(asText(value));
  });
}

/** Query parameters from their templates; a parameter with a missing variable is left out. */
export function fillQuery(template: Readonly<Record<string, string>> | undefined, vars: Vars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(template ?? {})) {
    const filled = fillString(value, vars);
    if (filled !== OMIT) out[key] = asText(filled);
  }
  return out;
}

/** Whether a template refers to a variable anywhere. */
export function mentions(template: Json | string | undefined, name: string): boolean {
  if (template === undefined) return false;
  const text = typeof template === "string" ? template : JSON.stringify(template);
  return text.includes(`{${name}}`);
}
