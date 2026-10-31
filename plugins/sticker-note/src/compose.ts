// What a phrase means when it is a job for an agent rather than a note or a
// task: inside an open card ("найди письмо и приложи") and on the board
// ("попроси агента сравнить тарифы").

export type ComposeDecision = { type: "note"; text: string } | { type: "chat"; text: string };

/**
 * Russian imperatives that ask for work ("найди", "подготовь", "напишите").
 * Infinitives ("написать в телеграм") are the user's own plan and stay notes.
 */
const RU_DO = [
  "найди", "поищи", "сравни", "собери", "посчитай", "подготовь", "проверь", "узнай", "выясни", "составь",
  "разберись", "напиши", "ответь", "перешли", "отправь", "создай", "придумай", "переведи", "оформи", "распиши",
  "опиши", "сформулируй", "набросай", "прочитай", "прочти", "изучи", "проанализируй", "сократи", "перескажи",
  "объясни", "спроси", "забронируй", "закажи", "запланируй", "назначь", "вытащи", "достань", "скачай", "загрузи",
  "приложи", "вложи", "положи", "сохрани", "выгрузи", "свяжись", "подбери", "посмотри", "глянь", "суммируй",
];
/** English verbs of work count only at the start: "book" and "plan" are nouns too. */
const EN_DO = [
  "find", "compare", "prepare", "check", "research", "look\\s+up", "figure\\s+out", "draft", "write", "reply",
  "answer", "send", "forward", "create", "summari[sz]e", "translate", "plan", "book", "schedule", "attach",
  "save", "download", "analy[sz]e", "explain", "read", "collect", "gather", "ask",
];
const ASK = new RegExp(`(?<![\\p{L}])(?:${RU_DO.join("|")})(?:те)?(?![\\p{L}])`, "giu");
const EN_ASK_LEAD = new RegExp(`^\\s*(?:please\\s+)?(?:${EN_DO.join("|")})(?![\\p{L}])`, "iu");

/** "Попроси агента…", "агент, …", "поручи…", "ask the agent to…". */
const AGENT_LEAD =
  /^\s*(?:(?:попроси|поручи|пусть)\s+(?:агента?|агенту|ассистента?|ассистенту)(?![\p{L}])|агент(?:у)?\s*[,:]|поручи(?:ть)?(?![\p{L}])|ask\s+(?:the\s+|an\s+)?agent(?:\s+to)?(?![\p{L}])|agent\s*[,:])[\s,:—-]*/iu;

const NEW_CHAT_LEAD = /^\s*(?:в\s+новом\s+чате|новый\s+чат|new\s+chat|in\s+a\s+new\s+chat)(?![\p{L}])[\s,:—-]*/iu;

const NOTE_LEAD = /^\s*(?:добавь|допиши|запиши|отметь|note|add)(?:\s*,)?(?:\s+(?:что|that))?(?![\p{L}])[\s,:—-]*/iu;

/** "Добавь…", "допиши…", "отметь, что…": a note, even when a command word follows. */
const EXPLICIT_NOTE =
  /^\s*(?:(?:добавь|допиши|запиши|note|add)(?![\p{L}])|(?:отметь|mark)\s*,?\s+(?:что|that)(?![\p{L}]))/iu;

function tidy(text: string): string {
  const out = text.replace(/\s{2,}/g, " ").replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const words = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
const askCount = (text: string) => {
  ASK.lastIndex = 0;
  return [...text.matchAll(ASK)].length + (EN_ASK_LEAD.test(text) ? 1 : 0);
};

export function isExplicitNote(phrase: string): boolean {
  return EXPLICIT_NOTE.test(phrase);
}

/** "В новом чате…": a fresh agent chat even when the card has one. */
export function wantsNewChat(phrase: string): boolean {
  return NEW_CHAT_LEAD.test(phrase);
}

export interface ComposeContext {
  /** The card's agent asked something and waits: the next words are the answer. */
  agentAsks?: boolean;
  /** The card has a chat it follows: the composer talks to it, notes need "запиши". */
  chatLive?: boolean;
}

/**
 * Inside a card: a detail for the notes, or work for an agent. A request with a
 * verb of work ("найди", "подготовь", "напиши ответ") goes to the agent, and so
 * does anything once the card has a chat going: then a note needs "запиши".
 */
export function decide(phrase: string, context: ComposeContext = {}): ComposeDecision {
  const bare = phrase.replace(NEW_CHAT_LEAD, "");
  if (isExplicitNote(bare)) return { type: "note", text: tidy(bare.replace(NOTE_LEAD, "")) || tidy(bare) };
  const forAgent = AGENT_LEAD.test(bare) || askCount(bare) > 0 || context.agentAsks === true || context.chatLive === true;
  if (forAgent) return { type: "chat", text: tidy(bare.replace(AGENT_LEAD, "")) || tidy(bare) };
  return { type: "note", text: tidy(bare) };
}

/**
 * On the board: a phrase that is a job for an agent, not a task for the user.
 * "Найди подарок маме" stays a task; "Найди письмо от поставщика про тарифы и
 * подготовь ответ" is a job: addressed to the agent, several verbs of work, or
 * one at the start of a long phrase.
 */
export function isAgentJob(phrase: string): boolean {
  if (AGENT_LEAD.test(phrase)) return true;
  const n = askCount(phrase);
  if (n >= 2 && words(phrase) >= 6) return true;
  ASK.lastIndex = 0;
  const first = ASK.exec(phrase);
  const leads = (first !== null && phrase.slice(0, first.index).trim() === "") || EN_ASK_LEAD.test(phrase);
  return leads && words(phrase) >= 9;
}

/** The job as the agent should read it: without "попроси агента". */
export function jobText(phrase: string): string {
  return tidy(phrase.replace(AGENT_LEAD, "")) || tidy(phrase);
}

/** An answer that ends with a question waits for the user. */
export function asksUser(answer: string | null): boolean {
  if (!answer) return false;
  const tail = answer.trim().split(/\n\s*\n/).pop() ?? "";
  return /\?\s*\**\s*$/u.test(tail.trim());
}
