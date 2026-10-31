// Names people understand. Platforms name a person's server after the template
// it was made from plus an instance id ("corp_ai_gitlab_8ce17341"), so the
// catalog of templates gives the human name and the one line of what it does.
// When no template matches, the server's own `initialize` answer does
// (serverInfo.title or name, the first sentence of its instructions); failing
// both, the id itself made readable.
//
// Template and server texts come from other systems: they are cut to a fixed
// length first and cleaned with single-pass patterns only.
import type { CatalogItem } from "../../contract.js";

export const TITLE_MAX = 80;
export const SUMMARY_MAX = 160;

/** What a server says about itself in `initialize`. */
export interface ServerInfo {
  name: string | null;
  title: string | null;
  /** The first sentence of its instructions. */
  summary: string | null;
}

/** The template a server was made from, as the catalog described it when matched. */
export interface Template {
  id: string;
  name: string;
  description: string | null;
}

/** One line of display text: control, format and line-break characters become spaces, then cut to `max`. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .slice(0, max * 4)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\s]+/g, " ")
    .trim();
  if (clean === "") return null;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** The first sentence of the first non-empty line, without Markdown markers: "## Wiki search. More" → "Wiki search." */
export function firstSentence(value: unknown, max = SUMMARY_MAX): string | null {
  if (typeof value !== "string") return null;
  for (const raw of value.slice(0, 4000).split("\n")) {
    const line = cleanText(raw.replace(/^[\s#>*+-]+/, ""), 1000);
    if (line === null) continue;
    const stop = line.search(/[.!?](?:\s|$)/);
    return cleanText(stop >= 0 ? line.slice(0, stop + 1) : line, max);
  }
  return null;
}

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** The server's name without its trailing instance id: "corp_ai_gitlab_8ce17341" → "corp_ai_gitlab". */
export function baseName(name: string): string {
  return key(name.slice(0, 200)).replace(/_(?=[0-9a-f]*\d)[0-9a-f]{6,}$/, "");
}

/**
 * The catalog template a server was made from: its id or name, as a word
 * sequence, ends the server's name once the instance id is cut off. The
 * longest such match wins, so "ai_gitlab" beats "gitlab".
 */
export function templateFor(serverName: string, items: readonly CatalogItem[]): CatalogItem | null {
  const base = baseName(serverName);
  let best: CatalogItem | null = null;
  let bestLength = 0;
  for (const item of items) {
    for (const candidate of [key(item.id), key(item.name)]) {
      if (candidate.length < 2 || candidate.length <= bestLength) continue;
      if (base === candidate || base.endsWith(`_${candidate}`)) {
        best = item;
        bestLength = candidate.length;
      }
    }
  }
  return best;
}

/** "corp_ai_gitlab_8ce17341" → "Corp ai gitlab": the last resort when nothing describes the server. */
export function readableId(name: string): string {
  const words = baseName(name).replace(/_/g, " ").trim() || name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function titleOf(name: string, template: Template | null | undefined, info: ServerInfo | null | undefined): string {
  return cleanText(template?.name, TITLE_MAX) ?? cleanText(info?.title, TITLE_MAX) ?? cleanText(info?.name, TITLE_MAX) ?? readableId(name);
}

export function summaryOf(template: Template | null | undefined, info: ServerInfo | null | undefined): string | null {
  return firstSentence(template?.description) ?? cleanText(info?.summary, SUMMARY_MAX);
}

/** What `initialize` says about the server, cleaned; null when it says nothing. */
export function serverInfoFrom(result: Record<string, unknown>): ServerInfo | null {
  const about = result.serverInfo !== null && typeof result.serverInfo === "object" ? (result.serverInfo as Record<string, unknown>) : {};
  const info: ServerInfo = {
    name: cleanText(about.name, TITLE_MAX),
    title: cleanText(about.title, TITLE_MAX),
    summary: firstSentence(result.instructions),
  };
  return info.name === null && info.title === null && info.summary === null ? null : info;
}
