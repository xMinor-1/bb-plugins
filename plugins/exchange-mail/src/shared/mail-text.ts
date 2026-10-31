// Plain text of a message, made readable. Exchange turns HTML mail into text
// with every link written out after its words — `Bob<mailto:bob@example.com>`,
// `site<https://example.com/>` — so signatures read as a jumble. Shared by the
// host (agents read the cleaned text) and the panel (which shows the links).

export type TextPart = { kind: "text"; text: string } | { kind: "link"; href: string; label: string };

/** Line breaks, stray spaces and blank-line runs, the way people would type them. */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/** Only web and mail links: no javascript:, data:, file: or anything a click should not open. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_HREF.test(trimmed) ? trimmed : null;
}

const strip = (value: string) => value.replace(/^mailto:/i, "").replace(/\/+$/, "").toLowerCase();

// `word<target>`: what Exchange writes for a link, the word taken with it. Then bare web links and addresses.
const PATTERN = /(\S*)<((?:https?:\/\/|mailto:)[^\s<>]+)>|\b(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** The text split into plain runs and links. A link whose words repeat its address is shown once. */
export function textParts(input: string): TextPart[] {
  const parts: TextPart[] = [];
  const push = (text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === "text") last.text += text;
    else parts.push({ kind: "text", text });
  };
  let at = 0;
  for (const match of input.matchAll(PATTERN)) {
    const [whole, word, bracketed, url, email] = match;
    push(input.slice(at, match.index));
    at = match.index! + whole.length;
    if (bracketed !== undefined) {
      const href = safeHref(bracketed);
      if (!href) push(whole);
      else if (word && strip(word) === strip(href)) parts.push({ kind: "link", href, label: word });
      else {
        // The words stay; the address follows them as a link of its own.
        push(word ?? "");
        const label = /^mailto:/i.test(href) ? href.slice(7) : hostOf(href);
        parts.push({ kind: "link", href, label: word ? ` ${label}` : label });
      }
    } else if (url) parts.push({ kind: "link", href: url, label: url });
    else if (email) parts.push({ kind: "link", href: `mailto:${email}`, label: email });
  }
  push(input.slice(at));
  return parts;
}

function hostOf(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

/** For agents: duplicate link targets dropped, the rest written as `words <address>`. */
export function readableText(input: string): string {
  return normalizeText(input).replace(/(\S*)<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, (whole, word: string, target: string) => {
    if (word && strip(word) === strip(target)) return word;
    const shown = target.replace(/^mailto:/i, "");
    return word ? `${word} <${shown}>` : `<${shown}>`;
  });
}
