// What a phrase said inside an open card means: a detail to keep in the
// card's notes, or a request to hand to an agent as a new chat.

export type ComposeDecision = { type: "note"; text: string } | { type: "chat"; text: string };

const ASK =
  /(?<![\p{L}])(?:попроси\p{L}*|поручи\p{L}*|агент\p{L}*|найди|найти|поищи|сравни\p{L}*|собери|собрать|посчитай|подготовь|проверь|узнай|выясни|составь|разберись|ask|find|compare|prepare|check|research|look\s+up|figure\s+out|draft)(?![\p{L}])/iu;

const NOTE_LEAD = /^\s*(?:добавь|допиши|запиши|отметь|note|add)(?:\s*,)?(?:\s+(?:что|that))?(?![\p{L}])[\s,:—-]*/iu;
const CHAT_LEAD =
  /^\s*(?:попроси|поручи)\s+(?:агента?|агенту|ассистента?)(?![\p{L}])[\s,:—-]*|^\s*ask\s+(?:the\s+|an\s+)?agent\s+to(?![\p{L}])[\s,:—-]*/iu;

function tidy(text: string): string {
  const out = text.replace(/\s{2,}/g, " ").replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function decide(phrase: string): ComposeDecision {
  if (ASK.test(phrase)) return { type: "chat", text: tidy(phrase.replace(CHAT_LEAD, "")) || tidy(phrase) };
  return { type: "note", text: tidy(phrase.replace(NOTE_LEAD, "")) || tidy(phrase) };
}

/** "Добавь…", "допиши…", "отметь, что…": a note, even when a command word follows. */
const EXPLICIT_NOTE =
  /^\s*(?:(?:добавь|допиши|запиши|note|add)(?![\p{L}])|(?:отметь|mark)\s*,?\s+(?:что|that)(?![\p{L}]))/iu;

export function isExplicitNote(phrase: string): boolean {
  return EXPLICIT_NOTE.test(phrase);
}
