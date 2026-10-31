// Turning a chat message into sticker text: no markdown, a short title.

/** Plain text from an agent's markdown: no emphasis, headings, list markers or link syntax. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ""))
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, "$1 $2")
    .replace(/(\*\*|__)(.+?)\1/gs, "$2")
    .replace(/(?<![\p{L}\p{N}*])[*_](\S[^*_\n]*?)[*_](?![\p{L}\p{N}*])/gu, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first sentence or line: the title of a sticker made from a longer message. */
export function firstSentence(text: string): string {
  const line = text.split(/\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const m = /^(.+?[.!?…])(?=\s|$)/u.exec(line);
  return (m ? m[1]! : line).replace(/[.:;,]+$/u, "").trim();
}

/** At most `max` characters, cut at a word with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
