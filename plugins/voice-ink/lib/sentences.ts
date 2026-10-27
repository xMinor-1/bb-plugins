// The agent's reply arrives as a stream of small text deltas. Speaking can
// start as soon as the first sentence is complete, long before the reply is,
// so the stream is cut into sentences as it comes in.
//
// What is never read aloud is dropped here: fenced code, table rows and bb
// message directives. Everything else — links, inline code, digits, Latin —
// goes to the speech service, which turns it into words it can pronounce.

/** Past this a sentence is cut at a comma or a space: one long run would delay the first sound. */
const MAX_SENTENCE_CHARS = 240;

/** A sentence ends at terminal punctuation followed by whitespace; "0.47" and "т.е." stay whole. */
const SENTENCE_END = /[.!?…]+["»”')\]]*\s+/g;

function isSilentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("|") || // a table row
    trimmed.startsWith("::") || // a bb message directive
    /^[-*_]{3,}$/.test(trimmed) // a horizontal rule
  );
}

export class SentenceStream {
  private partial = "";
  private inFence = false;
  private carry = "";

  /** Add a delta; returns the sentences it completed, in order. */
  push(delta: string): string[] {
    this.partial += delta;
    const out: string[] = [];
    let newline = this.partial.indexOf("\n");
    while (newline !== -1) {
      const line = this.partial.slice(0, newline);
      this.partial = this.partial.slice(newline + 1);
      this.takeLine(line, out);
      newline = this.partial.indexOf("\n");
    }
    // The unfinished line: speak the sentences it already holds, keep the rest.
    // A line that may yet turn out to be a fence, a table row or a directive
    // waits for its line break, since its first characters decide that.
    const head = this.partial.trimStart();
    if (!this.inFence && head !== "" && !/^[`|:]/.test(head)) {
      this.cutSentences(this.carry + this.partial, out, false);
      this.partial = "";
    }
    return out;
  }

  /** The reply is over: whatever is left is the last sentence. */
  flush(): string[] {
    const out: string[] = [];
    if (this.partial !== "") this.takeLine(this.partial, out);
    this.partial = "";
    const rest = this.carry.trim();
    this.carry = "";
    if (rest !== "") out.push(rest);
    return out;
  }

  private takeLine(line: string, out: string[]): void {
    if (line.trimStart().startsWith("```")) {
      this.inFence = !this.inFence;
      return;
    }
    if (this.inFence || isSilentLine(line)) return;
    // A line break ends a sentence too: headings and list items carry no period.
    this.cutSentences(`${this.carry}${line}\n`, out, true);
  }

  private cutSentences(text: string, out: string[], lineEnded: boolean): void {
    let start = 0;
    SENTENCE_END.lastIndex = 0;
    for (let match = SENTENCE_END.exec(text); match !== null; match = SENTENCE_END.exec(text)) {
      const end = match.index + match[0].length;
      const sentence = text.slice(start, end).trim();
      if (sentence !== "") out.push(sentence);
      start = end;
    }
    let rest = text.slice(start);
    if (lineEnded) {
      if (rest.trim() !== "") out.push(rest.trim());
      rest = "";
    }
    while (rest.length > MAX_SENTENCE_CHARS) {
      const window = rest.slice(0, MAX_SENTENCE_CHARS);
      const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" "));
      const at = cut > MAX_SENTENCE_CHARS / 3 ? cut + 1 : MAX_SENTENCE_CHARS;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    this.carry = rest;
  }
}
