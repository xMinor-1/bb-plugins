// Text written by other people on its way into an agent's context or a confirmation window: chat
// names, positions, messages. Nothing here reads a message as an instruction; it keeps such text
// from changing how the surrounding answer, prompt or window reads.

/**
 * Controls other than tab and newline, direction overrides, and characters with no visible form.
 * The joiners that emoji and some scripts need (U+200C, U+200D, U+FE0F) stay: they change nothing a
 * person would misread. Code points, not literals: a line separator inside a regular expression
 * literal does not survive editing.
 */
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
];

const escaped = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;
const HIDDEN_CLASS = `[${HIDDEN_RANGES.map(([from, to]) => `${escaped(from)}-${escaped(to)}`).join("")}]`;
const HIDDEN_ANY = new RegExp(HIDDEN_CLASS);
const HIDDEN_ALL = new RegExp(HIDDEN_CLASS, "g");

export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_ANY.test(text);
}

/** Line ends as `\n`, without the characters a person cannot see. Keeps the lines. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(HIDDEN_ALL, "");
}

/** One visible line: no hidden characters, no line breaks, cut to `max`. */
export function oneLine(value: string, max = 120): string {
  const line = cleanText(value).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A name in an answer or a prompt: one line in quotes, so it cannot close the quote or start a line of its own. */
export function quoted(value: string, max = 120): string {
  return JSON.stringify(oneLine(value, max));
}

/** Other people's text between two marked lines. The mark is new on every call, so the text cannot end the block itself. */
export function dataBlock(label: string, body: string): string {
  const mark = globalThis.crypto.randomUUID().slice(0, 8);
  return `--- ${label} ${mark} ---\n${body}\n--- end of ${label} ${mark} ---`;
}

/** A message of several lines stays one entry: only its first line starts at the margin. */
export function indentedLines(text: string): string {
  return cleanText(text).split("\n").join("\n    ");
}
