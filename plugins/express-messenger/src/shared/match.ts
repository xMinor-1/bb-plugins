// Finding a chat or a person from the words a person uses: "Volkov Alexander" written in Cyrillic
// finds "Alexander Volkov", a diminutive ("Sasha") finds the full name, and a chat named with
// Latin and Cyrillic letters mixed is found either way. Pure functions; the directory is built on
// the host. The answer is the best few candidates with a score: the agent picks one or asks.

const RU_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l",
  м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch",
  ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
// Cyrillic letters that look like Latin ones: chat names are often typed with both mixed.
const RU_LOOK: Record<string, string> = { ...RU_LAT, х: "x", ц: "c", с: "c", р: "p", у: "y", к: "k" };

// Russian diminutives → full names. Both sides of a comparison try the full name too.
const NICK: Record<string, readonly string[]> = {
  саша: ["александр", "александра"], шура: ["александр"], алекс: ["александр", "алексей"],
  леша: ["алексей"], дима: ["дмитрий"], митя: ["дмитрий"], женя: ["евгений", "евгения"],
  миша: ["михаил"], паша: ["павел"], петя: ["петр"], ваня: ["иван"], вова: ["владимир"], володя: ["владимир"],
  вася: ["василий"], коля: ["николай"], костя: ["константин"], сережа: ["сергей"], толя: ["анатолий"],
  федя: ["федор"], юра: ["юрий"], слава: ["вячеслав", "ярослав", "святослав"], стас: ["станислав"],
  влад: ["владислав", "владимир"], гриша: ["григорий"], гоша: ["георгий"], жора: ["георгий"], витя: ["виктор"],
  боря: ["борис"], рома: ["роман"], тема: ["артем"], леня: ["леонид"], гена: ["геннадий"],
  маша: ["мария"], даша: ["дарья"], настя: ["анастасия"], катя: ["екатерина"], лена: ["елена"],
  оля: ["ольга"], таня: ["татьяна"], наташа: ["наталья", "наталия"], света: ["светлана"], юля: ["юлия"],
  аня: ["анна"], ира: ["ирина"], вика: ["виктория"], ксюша: ["ксения"], люба: ["любовь"], надя: ["надежда"],
  галя: ["галина"], лиза: ["елизавета"], соня: ["софия", "софья"], поля: ["полина"],
};

const lower = (s: unknown) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const translit = (s: string, table = RU_LAT) => [...lower(s)].map((ch) => table[ch] ?? ch).join("");

/** One spelling for the many ways a name is written: Aleksandr / Alexander / Александр → aleksandr. */
export function phonetic(word: string): string {
  return translit(word)
    .replace(/[^a-z0-9]/g, "")
    .replace(/x/g, "ks")
    .replace(/shch|sch/g, "sh")
    .replace(/kh/g, "h")
    .replace(/tz|ts/g, "c")
    .replace(/ph/g, "f")
    .replace(/w/g, "v")
    .replace(/[yj]/g, "i")
    .replace(/(.)\1+/g, "$1")
    // English endings: Alexander → aleksandr, Peter → petr.
    .replace(/([dt])er$/, "$1r");
}

/** How a chat name looks, for names with Latin and Cyrillic letters mixed. */
export function lookKey(s: string): string {
  return translit(s, RU_LOOK).replace(/[^a-z0-9]/g, "");
}

const tokens = (s: string) => lower(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function sim(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // The start of a word: a few letters of a surname.
  if (a.length >= 3 && b.startsWith(a)) return 0.85 + 0.1 * (a.length / b.length);
  return Math.max(0, 1 - lev(a, b) / Math.max(a.length, b.length));
}

function queryVariants(tok: string): string[] {
  const out = new Set([phonetic(tok)]);
  for (const full of NICK[lower(tok)] ?? []) out.add(phonetic(full));
  for (const [nick, fulls] of Object.entries(NICK)) {
    if (phonetic(nick) === phonetic(tok)) for (const f of fulls) out.add(phonetic(f));
  }
  return [...out];
}

/** How well a query matches one name, 0..1. Word order does not matter. */
export function score(query: string, name: string): number {
  const qTok = tokens(query);
  const nTok = tokens(name).map(phonetic).filter(Boolean);
  if (!qTok.length || !nTok.length) return 0;
  let sum = 0;
  for (const t of qTok) {
    let best = 0;
    for (const v of queryVariants(t)) for (const n of nTok) best = Math.max(best, sim(v, n));
    sum += best;
  }
  let s = sum / qTok.length;
  // Extra words in the name lower the score a little: a person over a team chat with the same surname.
  s -= Math.min(0.1, Math.max(0, nTok.length - qTok.length) * 0.03);
  const qLook = lookKey(query);
  const nLook = lookKey(name);
  if (qLook && nLook) {
    if (qLook === nLook) s = Math.max(s, 1);
    else if (qLook.length >= 4 && nLook.includes(qLook)) s = Math.max(s, 0.85);
    else s = Math.max(s, sim(phonetic(query), phonetic(name)) * 0.95);
  }
  return Math.max(0, Math.min(1, s));
}

/** Every word of the query is one of the name's words exactly (in some spelling): "Волков" is Volkov, not Volkova. */
export function exactWords(query: string, name: string): boolean {
  const qTok = tokens(query);
  const nTok = new Set(tokens(name).map(phonetic).filter(Boolean));
  return qTok.length > 0 && qTok.every((t) => queryVariants(t).some((v) => nTok.has(v)));
}

export interface Matchable {
  readonly name: string | null;
  readonly aliases?: readonly string[];
}

export interface Match<E> {
  readonly entry: E;
  readonly score: number;
}

/**
 * The best candidates. `ambiguous`: the first two are too close for an agent to choose alone.
 * `strict` (for sending): the runner-up must also trail clearly, or the answer is ambiguous.
 */
export function findBest<E extends Matchable>(
  query: string,
  entries: readonly E[],
  { limit = 3, minScore = 0.55, strict = false }: { limit?: number; minScore?: number; strict?: boolean } = {},
): { matches: Match<E>[]; ambiguous: boolean } {
  const matches = entries
    .map((entry) => {
      const names = [entry.name, ...(entry.aliases ?? [])].filter((n): n is string => !!n);
      return { entry, score: names.length ? Math.max(...names.map((n) => score(query, n))) : 0 };
    })
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const [first, second] = matches;
  let ambiguous = false;
  if (first && second) {
    const gap = first.score - second.score;
    // An exact match stands even next to a near one ("Volkov Alexander" beside "Volkova Alexandra"),
    // and so does a name that has every word of the query when the runner-up lacks one. For sending,
    // one word is too little for that: "Volkov" alone still asks when there is a Volkova.
    const wordsDecide = (!strict || tokens(query).length >= 2) && first.score >= 0.95 && hasEveryWord(query, first.entry) && !hasEveryWord(query, second.entry);
    const exact = (first.score >= 0.99 && second.score < 0.95) || wordsDecide;
    ambiguous = gap < (strict ? 0.12 : 0.06) && !exact;
  }
  return { matches, ambiguous };
}

function hasEveryWord(query: string, entry: Matchable): boolean {
  return [entry.name, ...(entry.aliases ?? [])].some((n) => !!n && exactWords(query, n));
}
