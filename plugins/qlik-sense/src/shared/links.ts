// Qlik Sense addresses: the base URL a person types, links into apps and sheets,
// and parsing a link someone pasted from their browser.

/** Normalizes the address typed in setup to `https://host[/virtual-proxy]/`. */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`"${input}" is not a web address`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The Qlik Sense address must start with https://");
  }
  // People paste whatever is in the address bar: keep only the virtual proxy prefix.
  const path = url.pathname.replace(/\/(hub|sense|qmc|single|internal_forms_authentication)(\/.*)?$/i, "");
  return `${url.origin}${path.replace(/\/*$/, "")}/`;
}

export function appLink(base: string, appId: string): string {
  return `${base}sense/app/${encodeURIComponent(appId)}/overview`;
}

export function sheetLink(base: string, appId: string, sheetId: string): string {
  return `${base}sense/app/${encodeURIComponent(appId)}/sheet/${encodeURIComponent(sheetId)}/state/analysis`;
}

export interface ParsedLink {
  readonly appId: string;
  readonly sheetId: string | null;
  readonly origin: string;
}

/** Reads the app and sheet ids out of a Qlik Sense link copied from a browser. */
export function parseQlikLink(input: string): ParsedLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const appAt = segments.findIndex((segment, i) => segment === "app" && segments[i - 1] === "sense");
  if (appAt >= 0 && segments[appAt + 1]) {
    const sheetAt = segments.indexOf("sheet", appAt + 2);
    return { appId: segments[appAt + 1]!, sheetId: sheetAt >= 0 ? (segments[sheetAt + 1] ?? null) : null, origin: url.origin };
  }
  // The single-object integration URL: /single/?appid=…&sheet=…
  const appId = url.searchParams.get("appid");
  if (appId) return { appId, sheetId: url.searchParams.get("sheet"), origin: url.origin };
  return null;
}
