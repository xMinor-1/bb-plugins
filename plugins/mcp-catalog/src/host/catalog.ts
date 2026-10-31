// The catalog of MCP servers people can create: a JSON list at an address the
// build sets, read without signing in. Accepted shapes: a list at the root, or
// under `items`, `templates`, `servers`, `data` or `results`; each item needs
// an id or a name. Read from this machine, which is the one inside the
// company network.
import type { CatalogItem } from "../../contract.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 500;
const TIMEOUT_MS = 10_000;

export class CatalogError extends Error {
  constructor(
    readonly code: "catalog-address" | "catalog-unreachable" | "catalog-format",
    message: string,
  ) {
    super(`[mcp:${code}] ${message}`);
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown, limit: number): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
  return trimmed === "" ? null : trimmed.slice(0, limit);
};

function listOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!isObject(body)) return null;
  for (const key of ["items", "templates", "servers", "data", "results"]) {
    const value = body[key];
    if (Array.isArray(value)) return value;
    if (isObject(value)) {
      const inner = listOf(value);
      if (inner) return inner;
    }
  }
  return null;
}

export function normalizeCatalog(body: unknown): CatalogItem[] {
  const list = listOf(body);
  if (list === null) throw new CatalogError("catalog-format", "The catalog answer is not a list of MCP servers.");
  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const id = text(raw.id ?? raw.slug ?? raw.key ?? raw.name, 200);
    const name = text(raw.name ?? raw.title ?? raw.display_name ?? raw.displayName, 200) ?? id;
    if (id === null || name === null || seen.has(id)) continue;
    seen.add(id);
    const category = raw.category ?? raw.group ?? (Array.isArray(raw.tags) ? raw.tags[0] : undefined);
    items.push({
      id,
      name,
      description: text(raw.description ?? raw.summary ?? raw.short_description, 2000),
      category: text(category, 100),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export async function fetchCatalog(address: string, options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<CatalogItem[]> {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new CatalogError("catalog-address", "The catalog address is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CatalogError("catalog-address", "The catalog address must start with https://.");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: "application/json" }, signal, redirect: "follow" });
  } catch {
    throw new CatalogError("catalog-unreachable", timeout.aborted ? "The catalog did not answer in time." : "The catalog cannot be reached from this machine.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CatalogError("catalog-unreachable", `The catalog answered HTTP ${response.status}.`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CatalogError("catalog-format", "The catalog answer is too large.");
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new CatalogError("catalog-format", "The catalog answer is too large.");
  try {
    return normalizeCatalog(JSON.parse(body));
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("catalog-format", "The catalog answer is not JSON.");
  }
}
