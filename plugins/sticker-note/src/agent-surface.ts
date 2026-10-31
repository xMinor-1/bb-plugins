// What agents get: the `bb sticker-note` command and native tools, so an agent
// in any thread can put something on the user's board ("сделай в Sticker Note
// заметку об этом") and keep a sticker up to date while it works on a job.
// Output is English: it is read by agents, not shown to the user.
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { columnOf } from "./board";
import type { LocalNow } from "./dates";
import type { Card, Importance, ParseResult } from "./model";

export interface AddInput {
  /** What to do, in the user's words; a date or time inside is understood. */
  title: string;
  when?: string;
  notes?: string[];
  links?: string[];
  importance?: Importance;
  work?: boolean;
}

export interface UpdateInput {
  title?: string;
  when?: string;
  notes?: string[];
  links?: string[];
  importance?: Importance;
  work?: boolean;
  done?: boolean;
}

export interface BoardOps {
  list(): Promise<Card[]>;
  userNow(): LocalNow;
  /** `threadId`: the chat the sticker comes from; the card links back to it. */
  add(input: AddInput, threadId: string | null): Promise<Card>;
  update(num: number, input: UpdateInput): Promise<Card>;
  say(text: string): Promise<{ parse: ParseResult; cards: Card[] }>;
}

export const SKILL = "sticker-note";
const TOOLS = ["sticker_note_add", "sticker_note_list", "sticker_note_update"] as const;

const COLUMN_NAMES = { today: "Today", soon: "Soon", later: "Later", done: "Done" } as const;

function whenOf(card: Card): string {
  return card.due ? `${card.due.date}${card.due.time ? ` ${card.due.time}` : ""}` : "no date";
}

/** One line per sticker: "#12  2026-11-02 13:00  Watch the deck  [work, important]". */
export function line(card: Card, today: string): string {
  const tags = [
    columnOf(card, today) === "done" ? "done" : null,
    card.kind === "work" ? "work" : null,
    card.importance === "high" ? "important" : card.importance === "low" ? "low priority" : null,
    card.notes.length ? `${card.notes.length} notes` : null,
    card.links.length ? `${card.links.length} links` : null,
  ].filter(Boolean);
  return `#${card.num}  ${whenOf(card)}  ${card.title}${tags.length ? `  [${tags.join(", ")}]` : ""}`;
}

export function details(card: Card, today: string): string {
  const out = [
    `#${card.num} ${card.title}`,
    `Column: ${COLUMN_NAMES[columnOf(card, today)]}`,
    `When: ${whenOf(card)}`,
    `Importance: ${card.importance}`,
    `Kind: ${card.kind}`,
  ];
  if (card.notes.length) out.push("Notes:", ...card.notes.map((n) => `- ${n}`));
  if (card.links.length) out.push("Links:", ...card.links.map((l) => `- ${l}`));
  for (const chat of card.chats) {
    out.push(`Agent chat${chat.threadId ? ` ${chat.threadId}` : ""}: ${chat.status}${chat.reply ? `, last answer: ${chat.reply.slice(0, 400)}` : ""}`);
  }
  return out.join("\n");
}

function added(card: Card, today: string): string {
  return `Added sticker #${card.num} “${card.title}” (${COLUMN_NAMES[columnOf(card, today)]}, ${whenOf(card)}). Tell the user its number.`;
}

function sayResult({ parse, cards }: { parse: ParseResult; cards: Card[] }, today: string): { text: string; ok: boolean } {
  switch (parse.type) {
    case "create":
      return { text: added(cards[0]!, today), ok: true };
    case "command":
      return {
        text: `${parse.action}: ${cards.map((c) => `#${c.num} “${c.title}”`).join(", ") || "nothing changed"}`,
        ok: true,
      };
    case "ambiguous":
      return { text: "Several stickers match; name it by its number (#12) or list them first.", ok: false };
    case "notFound":
      return { text: "No sticker matches; name it by its number (#12) or list them first.", ok: false };
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function registerAgentSurface(bb: BbPluginApi, board: BoardOps) {
  const fail = (cause: unknown, code: string): never => {
    throw new PluginCliError(cause instanceof Error ? cause.message : String(cause), {
      code,
      hint: "Run `bb sticker-note list` to see the stickers and their numbers.",
    });
  };
  const num = (raw: string): number => {
    const n = Number(raw.replace(/^#/, ""));
    if (!Number.isInteger(n) || n < 1) throw new PluginCliError(`"${raw}" is not a sticker number`, { code: "bad_number", hint: "Use the number shown on the sticker, like 12 or #12." });
    return n;
  };

  bb.cli.register(
    defineCli({
      name: "sticker-note",
      summary: "The user's personal sticky-note board (Sticker Note): add a sticker, list, show or change one",
      commands: {
        add: cliCommand({
          summary: "Add a sticker. The text may name a day and time (\"завтра в 10 …\"); the sticker links back to the calling chat",
          positionals: [{ name: "title", description: "What to do, in the user's words", required: true, variadic: true }] as const,
          options: {
            when: { type: "string", description: "Day and time in words or as a date: \"в пятницу в 12\", \"2026-11-06 12:00\", \"tomorrow 10am\"" },
            note: { type: "string", repeatable: true, description: "A note on the sticker; repeat for several (up to 8000 characters each)" },
            link: { type: "string", repeatable: true, description: "A link on the sticker; repeat for several" },
            important: { type: "boolean", description: "Mark the sticker important" },
            work: { type: "boolean", description: "A work task (otherwise personal unless the text says work)" },
            detached: { type: "boolean", description: "Do not link the sticker to the calling chat" },
            json: { type: "boolean", description: "Print the sticker as JSON" },
          },
          async run({ positionals, options }, ctx) {
            const card = await board
              .add(
                {
                  title: positionals.title.join(" "),
                  when: options.when,
                  notes: options.note,
                  links: options.link,
                  importance: options.important ? "high" : undefined,
                  work: options.work ? true : undefined,
                },
                options.detached ? null : (ctx.threadId ?? null),
              )
              .catch((cause: unknown) => fail(cause, "add_failed"));
            return { exitCode: 0, stdout: options.json ? json(card) : `${added(card, board.userNow().date)}\n` };
          },
        }),
        list: cliCommand({
          summary: "List open stickers by number, with day and time; --all adds finished ones",
          options: {
            all: { type: "boolean", description: "Include finished stickers (kept 60 days)" },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ options }) {
            const today = board.userNow().date;
            const cards = (await board.list()).filter((c) => options.all || !c.done).sort((a, b) => a.num - b.num).slice(-300);
            if (options.json) return { exitCode: 0, stdout: json(cards) };
            return { exitCode: 0, stdout: cards.length ? `${cards.map((c) => line(c, today)).join("\n")}\n` : "No stickers.\n" };
          },
        }),
        show: cliCommand({
          summary: "Everything on one sticker: notes, links, its agent chats",
          positionals: [{ name: "number", description: "Sticker number, like 12 or #12", required: true }] as const,
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run({ positionals, options }) {
            const n = num(positionals.number);
            const card = (await board.list()).find((c) => c.num === n);
            if (!card) fail(new Error(`No sticker #${n}`), "not_found");
            return { exitCode: 0, stdout: options.json ? json(card) : `${details(card!, board.userNow().date)}\n` };
          },
        }),
        update: cliCommand({
          summary: "Change a sticker: add notes or links, move it, rename, mark important or done",
          positionals: [{ name: "number", description: "Sticker number, like 12 or #12", required: true }] as const,
          options: {
            title: { type: "string", description: "New title" },
            when: { type: "string", description: "New day and time in words or as a date; \"someday\" clears it" },
            note: { type: "string", repeatable: true, description: "Add a note; repeat for several" },
            link: { type: "string", repeatable: true, description: "Add a link; repeat for several" },
            importance: { type: "enum", values: ["high", "normal", "low"], description: "Importance" },
            work: { type: "boolean", description: "Mark as a work task" },
            personal: { type: "boolean", description: "Mark as a personal task" },
            done: { type: "boolean", description: "Mark done" },
            reopen: { type: "boolean", description: "Mark not done" },
            json: { type: "boolean", description: "Print the sticker as JSON" },
          },
          constraints: [
            { kind: "at-most-one", options: ["done", "reopen"] },
            { kind: "at-most-one", options: ["work", "personal"] },
          ],
          async run({ positionals, options }) {
            const card = await board
              .update(num(positionals.number), {
                title: options.title,
                when: options.when,
                notes: options.note,
                links: options.link,
                importance: options.importance as Importance | undefined,
                work: options.work ? true : options.personal ? false : undefined,
                done: options.done ? true : options.reopen ? false : undefined,
              })
              .catch((cause: unknown) => fail(cause, "update_failed"));
            return { exitCode: 0, stdout: options.json ? json(card) : `Updated: ${line(card, board.userNow().date)}\n` };
          },
        }),
        say: cliCommand({
          summary: "Do what the board does with a dictated phrase: \"закрой задачи 6 и 1\", \"перенеси 3 на пятницу\", or a new task",
          positionals: [{ name: "phrase", description: "The phrase, Russian or English", required: true, variadic: true }] as const,
          async run({ positionals }) {
            const result = sayResult(await board.say(positionals.phrase.join(" ")), board.userNow().date);
            return result.ok ? { exitCode: 0, stdout: `${result.text}\n` } : { exitCode: 1, stderr: `${result.text}\n` };
          },
        }),
      },
    }),
  );

  const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });
  const guard = async (work: () => Promise<string>) => {
    try {
      return text(await work());
    } catch (cause) {
      return text(cause instanceof Error ? cause.message : String(cause), true);
    }
  };

  bb.agents.registerTool({
    name: "sticker_note_add",
    description:
      "Add a sticker to the user's personal task board (Sticker Note). Use when the user asks to make a sticker, a note, a reminder or a task " +
      "on the board (\"сделай стикер\", \"запиши в Sticker Note\", \"закинь на доску\", \"напомни\"). The sticker links back to this chat.",
    instructions:
      "Sticker Note is the user's personal task board in bb. When they ask for a sticker, note or reminder there, call sticker_note_add: " +
      "a short title in their words, the day and time in `when`, the essentials (summary, names, numbers, file paths) in `notes`, and URLs in `links`. " +
      "Then tell them the sticker's number.",
    presentation: { label: { pending: "Adding a sticker", completed: "Added a sticker" } },
    parameters: z.object({
      title: z.string().min(1).max(2000).describe("What to do, in the user's words and language; keep it short"),
      when: z.string().max(200).optional().describe('Day and time: "в пятницу в 12", "2026-11-06 12:00", "tomorrow 10am"'),
      notes: z.array(z.string().min(1).max(8000)).max(20).optional().describe("Details the user will need: summary, people, numbers, paths"),
      links: z.array(z.string().min(1).max(2000)).max(20).optional().describe("URLs to keep on the sticker"),
      important: z.boolean().optional().describe("Mark important"),
      work: z.boolean().optional().describe("A work task rather than a personal one"),
      link_chat: z.boolean().optional().describe("Link the sticker to this chat (default true)"),
    }),
    execute: (p, ctx) =>
      guard(async () => {
        const card = await board.add(
          { title: p.title, when: p.when, notes: p.notes, links: p.links, importance: p.important ? "high" : undefined, work: p.work },
          p.link_chat === false ? null : ctx.threadId,
        );
        return added(card, board.userNow().date);
      }),
  });

  bb.agents.registerTool({
    name: "sticker_note_list",
    description: "List the user's stickers in Sticker Note: number, day and time, title, tags. Open ones unless include_done.",
    presentation: { label: { pending: "Reading the sticker board", completed: "Read the sticker board" } },
    parameters: z.object({ include_done: z.boolean().optional().describe("Include finished stickers") }),
    execute: (p) =>
      guard(async () => {
        const today = board.userNow().date;
        const cards = (await board.list()).filter((c) => p.include_done || !c.done).sort((a, b) => a.num - b.num).slice(-300);
        return cards.length ? cards.map((c) => line(c, today)).join("\n") : "No stickers.";
      }),
  });

  bb.agents.registerTool({
    name: "sticker_note_update",
    description:
      "Change a sticker in Sticker Note by its number: add notes or links (results of a job, file paths), move it to another day, rename, " +
      "set importance, mark done or not done.",
    presentation: { label: { pending: "Updating a sticker", completed: "Updated a sticker" } },
    parameters: z.object({
      number: z.number().int().positive().describe("The sticker's number, as on the board"),
      title: z.string().min(1).max(500).optional(),
      when: z.string().max(200).optional().describe('New day and time in words or as a date; "someday" clears it'),
      add_notes: z.array(z.string().min(1).max(8000)).max(20).optional(),
      add_links: z.array(z.string().min(1).max(2000)).max(20).optional(),
      importance: z.enum(["high", "normal", "low"]).optional(),
      work: z.boolean().optional().describe("true: work task, false: personal"),
      done: z.boolean().optional(),
    }),
    execute: (p) =>
      guard(async () => {
        const card = await board.update(p.number, {
          title: p.title,
          when: p.when,
          notes: p.add_notes,
          links: p.add_links,
          importance: p.importance,
          work: p.work,
          done: p.done,
        });
        return `Updated: ${line(card, board.userNow().date)}`;
      }),
  });

  bb.agents.configure(() => ({ tools: [...TOOLS], skills: [SKILL] }));
}
