// Recipients typed into a To or Cc field: "Name <address>" or "address",
// separated by commas, semicolons or line breaks. A comma inside quotes or
// inside <…> is part of the recipient: address books write "Surname, Name".
// No imports: the panel and the host both use this.

export interface Recipient {
  readonly name: string | null;
  readonly email: string;
}

const SEPARATORS = new Set([",", ";", "\n"]);

/** Where each recipient starts, scanning once: separators outside quotes and <…>. */
function separatorsOf(text: string): number[] {
  const at: number[] = [];
  let quoted = false;
  let angle = false;
  for (let n = 0; n < text.length; n++) {
    const char = text[n]!;
    if (char === '"' && !angle) quoted = !quoted;
    else if (char === "<" && !quoted) angle = true;
    else if (char === ">" && !quoted) angle = false;
    else if (!quoted && !angle && SEPARATORS.has(char)) at.push(n);
  }
  return at;
}

export function splitRecipients(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const separator of [...separatorsOf(text), text.length]) {
    const part = text.slice(start, separator).trim();
    if (part) out.push(part);
    start = separator + 1;
  }
  return out;
}

/** The recipient being typed at the end of the field, and everything before it. */
export function lastRecipient(text: string): { head: string; typing: string } {
  const separators = separatorsOf(text);
  const cut = separators.length ? separators[separators.length - 1]! + 1 : 0;
  return { head: text.slice(0, cut), typing: text.slice(cut) };
}

/** "Name <address>", the name quoted when it holds a separator or a quote. */
export function recipientText(recipient: Recipient): string {
  const name = recipient.name?.trim();
  if (!name || name.toLowerCase() === recipient.email.toLowerCase()) return recipient.email;
  const safe = /[",;<>]/.test(name) ? `"${name.replace(/"/g, "'")}"` : name;
  return `${safe} <${recipient.email}>`;
}
