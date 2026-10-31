// Plain text of a message, made readable. Exchange turns HTML mail into text
// with every link written out after its words — `Bob<mailto:bob@example.com>`,
// `site<https://example.com/>` — so signatures read as a jumble. Shared by the
// host (agents read the cleaned text) and the panel (which shows the links).
//
// Mail is written by strangers, so everything here takes time in proportion to
// the length of the text: plain scans, and only regular expressions that start
// at a fixed character and cannot backtrack across the text. A pattern like
// `(\S*)<…>` or `[a-z]+@` looks harmless and takes minutes on 100 KB of one
// long word.

export type TextPart = { kind: "text"; text: string } | { kind: "link"; href: string; label: string };

/** Space or tab at the end of `line`, dropped without a regular expression (`/[ \t]+$/` is quadratic on long runs of spaces). */
function trimSpacesEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  return end === line.length ? line : line.slice(0, end);
}

/** Line breaks, stray spaces and blank-line runs, the way people would type them. */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/ /g, " ")
    .split("\n")
    .map(trimSpacesEnd)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/** Only web and mail links: no javascript:, data:, file: or anything a click should not open. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_HREF.test(trimmed) ? trimmed : null;
}

/** For comparing a link's words with its address: no mailto:, no trailing slashes, any case. */
function strip(value: string): string {
  let text = value.replace(/^mailto:/i, "");
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  text = text.slice(0, end);
  return text.toLowerCase();
}

const WHITESPACE = /\s/;
function isSpace(code: number): boolean {
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return WHITESPACE.test(String.fromCharCode(code));
}
const isWordChar = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isDigit = (code: number) => code >= 48 && code <= 57;
/** Characters of the part before @: letters, digits and ._%+- */
const isLocal = (code: number) => isLetter(code) || isDigit(code) || code === 46 || code === 95 || code === 37 || code === 43 || code === 45;
/** Characters of a domain: letters, digits, dots and hyphens. */
const isDomain = (code: number) => isLetter(code) || isDigit(code) || code === 46 || code === 45;
/** What may not end a bare link: it belongs to the sentence around it. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "'"]);

interface Bracketed {
  /** Where the words taken with the link start: the run of non-space characters before `<`. */
  readonly wordStart: number;
  readonly open: number;
  /** Just past `>`. */
  readonly end: number;
  readonly target: string;
}

const BRACKET_START = /<(?:https?:\/\/|mailto:)/gi;

/** Exchange's `word<target>` links, left to right, each with the words in front of it. */
function bracketed(input: string): Bracketed[] {
  const found: Bracketed[] = [];
  let floor = 0;
  for (const match of input.matchAll(BRACKET_START)) {
    const open = match.index!;
    if (open < floor) continue;
    const from = open + match[0].length;
    let close = from;
    // Stops at the next `<`, so scans never overlap.
    while (close < input.length) {
      const code = input.charCodeAt(close);
      if (code === 60 || code === 62 || isSpace(code)) break;
      close++;
    }
    if (close === from || input.charCodeAt(close) !== 62) continue;
    let wordStart = open;
    while (wordStart > floor && !isSpace(input.charCodeAt(wordStart - 1))) wordStart--;
    found.push({ wordStart, open, end: close + 1, target: input.slice(open + 1, close) });
    floor = close + 1;
  }
  return found;
}

/** Where an address that starts at `at` (just after @) ends: its last dot followed by two letters or more, and those letters. -1 when it is no domain. */
function domainEnd(text: string, at: number): number {
  let end = at;
  while (end < text.length && isDomain(text.charCodeAt(end))) end++;
  for (let dot = end - 3; dot > at; dot--) {
    if (text.charCodeAt(dot) !== 46 || !isLetter(text.charCodeAt(dot + 1)) || !isLetter(text.charCodeAt(dot + 2))) continue;
    let stop = dot + 1;
    while (stop < end && isLetter(text.charCodeAt(stop))) stop++;
    return stop;
  }
  return -1;
}

const BARE_ANCHOR = /https?:\/\/|@/gi;

/** Bare web links and addresses in text that holds no `word<target>` links. */
function bareLinks(text: string, push: (text: string) => void, link: (href: string, label: string) => void): void {
  let at = 0;
  for (const match of text.matchAll(BARE_ANCHOR)) {
    const index = match.index!;
    if (index < at) continue;
    if (match[0] === "@") {
      let start = index;
      while (start > at && isLocal(text.charCodeAt(start - 1))) start--;
      if (start === index) continue;
      const end = domainEnd(text, index + 1);
      if (end < 0) continue;
      const email = text.slice(start, end);
      push(text.slice(at, start));
      link(`mailto:${email}`, email);
      at = end;
    } else {
      if (index > 0 && isWordChar(text.charCodeAt(index - 1))) continue;
      const from = index + match[0].length;
      let end = from;
      while (end < text.length) {
        const code = text.charCodeAt(end);
        if (code === 60 || code === 62 || code === 34 || isSpace(code)) break;
        end++;
      }
      while (end > from && TRAILING.has(text[end - 1]!)) end--;
      if (end - from < 2) continue;
      const url = text.slice(index, end);
      push(text.slice(at, index));
      link(url, url);
      at = end;
    }
  }
  push(text.slice(at));
}

/** The text split into plain runs and links. A link whose words repeat its address is shown once. */
export function textParts(input: string): TextPart[] {
  const parts: TextPart[] = [];
  const push = (text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === "text") last.text += text;
    else parts.push({ kind: "text", text });
  };
  const link = (href: string, label: string) => parts.push({ kind: "link", href, label });
  let at = 0;
  for (const found of bracketed(input)) {
    bareLinks(input.slice(at, found.wordStart), push, link);
    at = found.end;
    const word = input.slice(found.wordStart, found.open);
    const href = safeHref(found.target);
    if (!href) push(input.slice(found.wordStart, found.end));
    else if (word && strip(word) === strip(href)) link(href, word);
    else {
      // The words stay; the address follows them as a link of its own.
      push(word);
      const label = /^mailto:/i.test(href) ? href.slice(7) : hostOf(href);
      link(href, word ? ` ${label}` : label);
    }
  }
  bareLinks(input.slice(at), push, link);
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
  const text = normalizeText(input);
  let out = "";
  let at = 0;
  for (const found of bracketed(text)) {
    out += text.slice(at, found.wordStart);
    at = found.end;
    const word = text.slice(found.wordStart, found.open);
    if (word && strip(word) === strip(found.target)) out += word;
    else {
      const shown = found.target.replace(/^mailto:/i, "");
      out += word ? `${word} <${shown}>` : `<${shown}>`;
    }
  }
  return out + text.slice(at);
}
