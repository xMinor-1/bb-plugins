// The messenger on this machine: one browser without a window on the plugin's own profile, one
// tab with the web client, one operation at a time. The browser closes after a few idle minutes;
// the watcher's checks keep it open while there are watch rules.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Chat, Lang, Matches, RuleDraft, Snapshot, Status, ToolCall, ToolOutput } from "../../contract.js";
import { tagged, type PanelCode } from "../shared/errors.js";
import { findBest, lookKey, score } from "../shared/match.js";
import { dataBlock, indentedLines, oneLine, quoted, UNTRUSTED_NOTE } from "../shared/untrusted.js";
import { BrowserError, findBrowser, Page, sleep, unreachableError } from "./browser.js";
import { oneAtATime, systemConfirmer, windowRefusal, type SendConfirmer } from "./confirm.js";
import { counts, loadDirectory, merge, saveDirectory, search, toChat, type Directory, type RawChat } from "./directory.js";
import {
  CLEAR_FIELD,
  COMPOSER_SELECTOR,
  DIRECTORY,
  FIELD_MENTION,
  FIND_MESSAGE,
  FOCUS_TARGET,
  LEAVE_THREAD,
  LOAD_PROFILES,
  MARK_PAGE,
  MENTION_ITEM,
  OPEN_CHAT,
  OPEN_THREAD,
  REACHABLE,
  READ_CHAT,
  READY,
  SEND_STATE,
  TARGET_SELECTOR,
  THREAD_STATE,
  WATCH_SNAPSHOT,
} from "./page.js";

/** A failure the panel and agents should read as "sign in first". */
export class SignInNeeded extends Error {
  constructor() {
    super("The messenger asks to sign in. Open the Messenger page in bb and press Sign in for this machine.");
  }
}

export class Busy extends Error {}

export interface ServiceOptions {
  readonly dataDir: string;
  readonly confirmer?: SendConfirmer;
  readonly browserPath?: string | null;
  /** Keeps the host worker alive while the browser runs. */
  readonly retain?: () => { dispose(): Promise<void> };
  readonly idleMs?: number;
  /** How long a saved directory serves searches without a fresh look at the client. */
  readonly directoryFreshMs?: number;
  /** How long the sign-in screen may show before a call gives up and asks to sign in. */
  readonly signInGraceMs?: number;
  /** Tests only: the sign-in "window" without a window, on a machine without a desktop. */
  readonly signInHeadless?: boolean;
  /** Steps of an answer in a thread, as counts and yes/no without any text: for a check on a real client. */
  readonly diagnose?: (line: string) => void;
}

const READY_TIMEOUT_MS = 90_000;
const SIGN_IN_WAIT_MS = 10 * 60_000;
const DUPLICATE_WINDOW_MS = 2 * 60_000;
const PROFILE_REMOVE_RETRIES = 8;
const PROFILE_REMOVE_DELAY_MS = 250;
/** A page already open answers at once, or something is wrong with it: its sign-in screen does not go away by itself. */
const OPEN_PAGE_READY_MS = 20_000;
const OPEN_PAGE_SIGN_IN_MS = 2000;
/** After a failed check the watcher leaves the browser alone for this long; each failure in a row moves to the next. */
const WATCH_PAUSE_MINUTES = [1, 2, 5, 10, 15];

/** How the panel says why a rule's window gave no yes. */
const WINDOW_CODES: Record<"cancelled" | "timeout" | "unavailable" | "busy", PanelCode> = { cancelled: "not-confirmed", timeout: "window-timeout", unavailable: "window-unavailable", busy: "window-busy" };

type Ready = { auth: boolean; unreachable: boolean; store: boolean; chats: number };
type SendState = { mine: number; own: number; empty: boolean; exact: boolean; sendButton: string };

/** A person of a chat, as FIND_MESSAGE returns them. */
interface ChatPerson {
  huid: string;
  name: string | null;
  position: string | null;
  department: string | null;
  email: string | null;
  aliases: string[];
}

/** What FIND_MESSAGE found: the messages that hold the piece of text (the last ten), the chat's people. */
interface Found {
  auth: boolean;
  missing: boolean;
  loaded: number;
  opens: number;
  total: number;
  hits: { syncId: string | null; at: number | null; from: string | null; mine: boolean; preview: string; threads: string[] }[];
  people: ChatPerson[];
}

type Opened = { opened: boolean; why?: "row" | "field"; how?: string; composers: number; loaded: number; settled: boolean };
type ThreadState = { composer: boolean; mine: number; same: number; inParent: number; lastMentionsPerson: boolean | null; field: string; inline: boolean; sendButton: string };
type FieldMention = { composer: boolean; mention: boolean; listOpen: boolean; endsWithSpace: boolean };
type MentionItem = { people: number; by: "id" | "name"; point: { x: number; y: number } | null; added: number; fieldHasAt: boolean; focused: boolean };

/** Host-only options of a tool call; agents cannot pass them. */
export interface ToolOptions {
  /** Types and checks everything, then clears the field instead of pressing the send key: a check on a real client that sends nothing. */
  readonly rehearse?: boolean;
}

export class MessengerService {
  private page: Page | null = null;
  private pageUrl: string | null = null;
  private lease: { dispose(): Promise<void> } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private signingIn = false;
  private lastError: string | null = null;
  private lastSent: { chatId: string; text: string; at: number } | null = null;
  private watchPause: { until: number; failures: number; error: string } | null = null;
  private readonly confirmer: SendConfirmer;
  private readonly profileDir: string;
  private readonly directoryFile: string;
  private readonly signInFile: string;
  private readonly idleMs: number;
  private readonly freshMs: number;

  constructor(private readonly options: ServiceOptions) {
    this.confirmer = options.confirmer ?? oneAtATime(systemConfirmer());
    this.profileDir = join(options.dataDir, "browser-profile");
    this.directoryFile = join(options.dataDir, "directory.json");
    this.signInFile = join(options.dataDir, "sign-in.json");
    this.idleMs = options.idleMs ?? 4 * 60_000;
    this.freshMs = options.directoryFreshMs ?? 12 * 3600_000;
  }

  private browserPath(): string {
    const path = this.options.browserPath === undefined ? findBrowser() : this.options.browserPath;
    if (!path) throw new BrowserError("no-browser", "No Chromium-based browser on this machine: install Google Chrome, Microsoft Edge or Chromium.");
    return path;
  }

  // ---------- What the last load of the client showed ----------

  /** True signed in, false asked to sign in, null never tried for this address. Survives a restart of the worker. */
  private signedInFor(url: string): boolean | null {
    try {
      const saved = JSON.parse(readFileSync(this.signInFile, "utf8")) as { url?: unknown; signedIn?: unknown };
      return saved.url === url && typeof saved.signedIn === "boolean" ? saved.signedIn : null;
    } catch {
      return null;
    }
  }

  private recordSignIn(url: string, signedIn: boolean): void {
    if (this.signedInFor(url) === signedIn) return;
    mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
    const temp = `${this.signInFile}.tmp`;
    writeFileSync(temp, JSON.stringify({ url, signedIn, at: Date.now() }), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.signInFile);
  }

  // ---------- The browser ----------

  /** Runs one operation on the page; the next waits. A sign-in window in progress refuses the rest. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.signingIn) return Promise.reject(new Busy("A sign-in window is open on this machine. Finish signing in first."));
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run.finally(() => this.scheduleIdle());
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.page) return;
    this.idleTimer = setTimeout(() => {
      // Refused while a sign-in window holds the profile; the sign-in closes the browser itself.
      this.exclusive(() => this.closePage()).catch(() => undefined);
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private async closePage(): Promise<void> {
    const page = this.page;
    this.page = null;
    this.pageUrl = null;
    if (page) await page.close().catch(() => undefined);
    const lease = this.lease;
    this.lease = null;
    await lease?.dispose().catch(() => undefined);
  }

  private async waitReady(page: Page, url: string, timeoutMs: number, signInAfterMs = this.options.signInGraceMs ?? 15_000): Promise<Ready> {
    const start = Date.now();
    const origin = new URL(url).origin;
    while (Date.now() - start < timeoutMs) {
      const ready = await page.evaluate<Ready>(READY(origin), 10_000).catch(() => null);
      if (ready?.store && ready.chats > 0 && !ready.auth) {
        this.recordSignIn(url, true);
        this.watchPause = null;
        return ready;
      }
      const waited = Date.now() - start;
      if (ready?.auth && waited > signInAfterMs) {
        this.recordSignIn(url, false);
        throw new SignInNeeded();
      }
      if (ready?.unreachable && waited > signInAfterMs) throw unreachableError();
      if (page.isClosed) throw new BrowserError("closed", "The browser closed.");
      await sleep(1000);
    }
    throw unreachableError(`the chats did not load in ${Math.round(timeoutMs / 1000)} s`);
  }

  /** The signed-in web client, without a window. A page already open is looked at again: a session can end, and the network can go, while it stays open. */
  private async ready(url: string): Promise<Page> {
    const open = this.page;
    if (open && !open.isClosed && this.pageUrl === url) {
      try {
        if (!(await open.evaluate<boolean>(REACHABLE, 12_000))) throw unreachableError();
        await this.waitReady(open, url, OPEN_PAGE_READY_MS, OPEN_PAGE_SIGN_IN_MS);
        return open;
      } catch (error) {
        await this.closePage();
        throw error;
      }
    }
    await this.closePage();
    const page = await Page.open({ browserPath: this.browserPath(), profileDir: this.profileDir, url, headless: true });
    this.page = page;
    this.pageUrl = url;
    this.lease ??= this.options.retain?.() ?? null;
    try {
      await this.waitReady(page, url, READY_TIMEOUT_MS);
    } catch (error) {
      await this.closePage();
      throw error;
    }
    return page;
  }

  /** A sign-in screen seen in the middle of an operation counts like one seen before it. */
  private async sessionEnded(url: string): Promise<never> {
    this.recordSignIn(url, false);
    await this.closePage();
    throw new SignInNeeded();
  }

  private remember<T>(work: Promise<T>): Promise<T> {
    return work.then(
      (value) => {
        this.lastError = null;
        return value;
      },
      (error: unknown) => {
        this.lastError = forPanel(error);
        throw error;
      },
    );
  }

  // ---------- The directory ----------

  private async refreshDirectory(url: string, page: Page, loadProfiles: boolean): Promise<Directory> {
    if (loadProfiles) await page.evaluate(LOAD_PROFILES, 5 * 60_000);
    const { chats, auth } = await page.evaluate<{ chats: RawChat[]; auth: boolean }>(DIRECTORY);
    if (auth) await this.sessionEnded(url);
    // An empty answer says nothing about the chats: the directory stays as it was.
    if (!chats.length) throw new BrowserError("page", "The web client gave no chats, so the directory was not changed.");
    const saved = loadDirectory(this.directoryFile, url);
    const directory: Directory = { url, at: Date.now(), chats: merge(chats, saved) };
    saveDirectory(this.directoryFile, directory);
    return directory;
  }

  /** The saved directory while fresh; otherwise, or when there is none, a look at the client. */
  private async directory(url: string, { live = false }: { live?: boolean } = {}): Promise<Directory> {
    // A session known to have ended: "nothing found" from an old file would be a wrong answer.
    if (this.signedInFor(url) === false) throw new SignInNeeded();
    const saved = loadDirectory(this.directoryFile, url);
    if (saved && !live && Date.now() - saved.at < this.freshMs) return saved;
    return this.exclusive(async () => this.refreshDirectory(url, await this.ready(url), !saved));
  }

  // ---------- Panel methods ----------

  async status(url: string): Promise<Status> {
    const saved = loadDirectory(this.directoryFile, url);
    let browser: string | null = null;
    try {
      browser = this.browserPath();
    } catch {
      browser = null;
    }
    return {
      platform: process.platform,
      browser,
      open: !!this.page && !this.page.isClosed,
      signedIn: this.signedInFor(url),
      directory: saved ? { at: saved.at, ...counts(saved) } : null,
      lastError: this.lastError,
    };
  }

  /**
   * A window for the person to sign in, closed again once the client has loaded the chats; then
   * the directory is built without a window, so search works right after signing in. `chats` and
   * `people` are zero when the directory could not be built: the sign-in still counts, and the
   * message says why the directory is missing.
   */
  async signIn(url: string): Promise<{ ok: boolean; message: string; chats: number; people: number }> {
    const signedIn = await this.signInWindow(url);
    if (!signedIn.ok) return { ...signedIn, chats: 0, people: 0 };
    const sync = await this.sync(url);
    if (sync.ok) return { ok: true, message: `Signed in. ${sync.message}`, chats: sync.chats, people: sync.people };
    return { ok: true, message: sync.message, chats: 0, people: 0 };
  }

  private async signInWindow(url: string): Promise<{ ok: boolean; message: string }> {
    if (this.signingIn) return { ok: false, message: "A sign-in window is already open on this machine." };
    // Refuses new operations from here on, so none slips in while the one in progress finishes.
    this.signingIn = true;
    try {
      await this.chain;
      await this.closePage();
      const page = await Page.open({ browserPath: this.browserPath(), profileDir: this.profileDir, url, headless: this.options.signInHeadless ?? false });
      try {
        const closed = page.exited().then(() => "closed" as const);
        // A failure is kept as a value: once the window is closed, nobody waits for this promise.
        const loaded = this.waitReady(page, url, SIGN_IN_WAIT_MS, SIGN_IN_WAIT_MS).then(
          () => "ready" as const,
          (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        );
        const outcome = await Promise.race([loaded, closed]);
        if (outcome instanceof Error) throw outcome;
        if (outcome === "closed") return { ok: false, message: "The window was closed before signing in finished." };
        // Give the browser a moment to write the session to the profile.
        await sleep(3000);
        this.lastError = null;
        return { ok: true, message: "Signed in." };
      } finally {
        await page.close();
      }
    } catch (error) {
      return { ok: false, message: forPanel(error) };
    } finally {
      this.signingIn = false;
    }
  }

  async sync(url: string): Promise<{ ok: boolean; message: string; chats: number; people: number }> {
    try {
      const directory = await this.remember(this.exclusive(async () => this.refreshDirectory(url, await this.ready(url), true)));
      const found = counts(directory);
      return { ok: true, message: `The directory has ${found.chats} chats and ${found.people} people.`, ...found };
    } catch (error) {
      return { ok: false, message: forPanel(error), chats: 0, people: 0 };
    }
  }

  async findChats(url: string, query: string, limit = 5): Promise<Matches> {
    try {
      const directory = await this.remember(this.directory(url));
      const found = search(directory, query, { limit });
      return { matches: found.matches.map((match) => ({ ...toChat(match.entry.raw), score: Math.round(match.score * 100) / 100 })), ambiguous: found.ambiguous };
    } catch (error) {
      throw new Error(forPanel(error));
    }
  }

  async chat(url: string, id: string): Promise<Chat | null> {
    const saved = loadDirectory(this.directoryFile, url);
    const raw = saved?.chats.find((chat) => chat.id === id);
    return raw ? toChat(raw) : null;
  }

  /**
   * For the watcher. While the session is known to have ended, or after a failed look, it answers
   * without touching the browser: starting Chrome every 30 s would help nothing. Direct calls from
   * agents and the panel do not wait for the pause, and their success ends it.
   */
  async snapshot(url: string, ids: readonly string[]): Promise<Snapshot> {
    if (this.signedInFor(url) === false) return { chats: {}, error: forPanel(new SignInNeeded()) };
    const pause = this.watchPause;
    if (pause && Date.now() < pause.until) return { chats: {}, error: pause.error };
    try {
      const chats = await this.remember(this.exclusive(async () => (await this.ready(url)).evaluate<Snapshot["chats"]>(WATCH_SNAPSHOT(ids), 20_000)));
      this.watchPause = null;
      return { chats, error: null };
    } catch (error) {
      if (error instanceof SignInNeeded || error instanceof Busy) return { chats: {}, error: forPanel(error) };
      const failures = (pause?.failures ?? 0) + 1;
      const minutes = WATCH_PAUSE_MINUTES[Math.min(failures, WATCH_PAUSE_MINUTES.length) - 1]!;
      const text = `${forPanel(error)} The watch rules look again in ${minutes} min.`;
      this.watchPause = { until: Date.now() + minutes * 60_000, failures, error: text };
      return { chats: {}, error: text };
    }
  }

  /** The system window for a new watch rule. What it names comes from the directory, not from the caller. */
  async confirmRule(url: string, draft: RuleDraft, signal?: AbortSignal): Promise<{ ok: boolean; message: string; chat: { id: string; name: string } | null }> {
    if (this.signedInFor(url) === false) return { ok: false, message: forPanel(new SignInNeeded()), chat: null };
    const raw = loadDirectory(this.directoryFile, url)?.chats.find((candidate) => candidate.id === draft.chatId);
    if (!raw) return { ok: false, message: tagged("not-in-directory", "This chat is not in the directory on that machine. Update the directory and try again."), chat: null };
    const chat = toChat(raw);
    const note = draft.note?.trim() || null;
    const refusal = note ? windowRefusal(note) : null;
    if (refusal) return { ok: false, message: `No rule was added. ${refusal}`, chat: null };
    const answer = await this.confirmer.confirmRule({ chat: chat.name, kind: chat.kind, members: chat.members, person: chat.person, last: draft.last, cooldownMinutes: draft.cooldownMinutes, note }, signal, draft.lang);
    if (!answer.ok) return { ok: false, message: tagged(WINDOW_CODES[answer.reason], answer.message), chat: null };
    return { ok: true, message: "Confirmed.", chat: { id: chat.id, name: chat.name } };
  }

  async close(): Promise<{ ok: boolean; message: string }> {
    await this.exclusive(() => this.closePage());
    return { ok: true, message: "The browser is closed." };
  }

  async forget(): Promise<{ ok: boolean; message: string }> {
    return this.exclusive(async () => {
      await this.closePage();
      rmSync(this.directoryFile, { force: true });
      rmSync(this.signInFile, { force: true });
      this.lastError = null;
      this.watchPause = null;
      try {
        // Windows keeps the files of a browser that has just exited busy for a moment.
        await rm(this.profileDir, { recursive: true, force: true, maxRetries: PROFILE_REMOVE_RETRIES, retryDelay: PROFILE_REMOVE_DELAY_MS });
      } catch {
        return { ok: false, message: "The directory is removed, but the browser profile with the sign-in is still in use. Close the browser and try again." };
      }
      return { ok: true, message: "The sign-in and the directory on this machine are removed." };
    });
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    void this.closePage();
  }

  // ---------- Agent tools ----------

  async tool(url: string, call: ToolCall, signal?: AbortSignal, options: ToolOptions = {}): Promise<ToolOutput> {
    try {
      switch (call.tool) {
        case "find":
          return await this.toolFind(url, call.query, call.limit ?? 3);
        case "unread":
          return await this.toolUnread(url, call.limit ?? 30);
        case "read":
          return await this.toolRead(url, call.chat, call.last ?? 10);
        case "send":
          return await this.toolSend(url, call.chat, call.text, call.lang, signal, options.rehearse ?? false);
        case "reply":
          return await this.toolReply(url, call, signal, options.rehearse ?? false);
      }
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true, chat: null };
    }
  }

  private async toolFind(url: string, query: string, limit: number): Promise<ToolOutput> {
    const directory = await this.remember(this.directory(url));
    const found = search(directory, query, { limit });
    if (!found.matches.length) {
      return { text: `No chat or person matches ${quoted(query)}. If the chat is new, the directory may be behind: try again in a minute.`, isError: false, chat: null };
    }
    const lines = found.matches.map((match) => describe(toChat(match.entry.raw), match.score));
    const top = toChat(found.matches[0]!.entry.raw);
    const text = [UNTRUSTED_NOTE, dataBlock("chats", lines.join("\n")), found.ambiguous ? "Several match about equally: ask the user which one they mean." : null].filter(Boolean).join("\n");
    return { text, isError: false, chat: found.ambiguous ? null : { id: top.id, name: top.name, kind: top.kind } };
  }

  private async toolUnread(url: string, limit: number): Promise<ToolOutput> {
    const directory = await this.remember(this.directory(url, { live: true }));
    const unread = directory.chats.filter((raw) => raw.unread > 0 && !raw.left && raw.name).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    if (!unread.length) return { text: "No unread messages.", isError: false, chat: null };
    const lines = unread.slice(0, limit).map((raw) => describe(toChat(raw)));
    const more = unread.length > limit ? `…and ${unread.length - limit} more chats with unread messages.` : null;
    return { text: [UNTRUSTED_NOTE, `Chats with unread messages (${unread.length}):`, dataBlock("chats", lines.join("\n")), more].filter(Boolean).join("\n"), isError: false, chat: null };
  }

  /** A chat by id, or by the user's words. `strict` (sending): only a clear winner counts. */
  private async resolve(url: string, query: string, strict: boolean): Promise<{ chat: RawChat } | { text: string }> {
    const directory = await this.directory(url);
    const byId = directory.chats.find((raw) => raw.id === query);
    if (byId) return { chat: byId };
    const found = search(directory, query, { limit: 3, strict });
    const top = found.matches[0];
    if (top && !found.ambiguous && top.score >= (strict ? 0.9 : 0.75)) return { chat: top.entry.raw };
    if (!found.matches.length) return { text: `No chat matches ${quoted(query)}. Find it with messenger_find first.` };
    return {
      text: [
        UNTRUSTED_NOTE,
        `${quoted(query)} does not name one chat clearly. Ask the user which one, then pass its id:`,
        dataBlock("chats", found.matches.map((match) => describe(toChat(match.entry.raw), match.score)).join("\n")),
      ].join("\n"),
    };
  }

  private async toolRead(url: string, query: string, last: number): Promise<ToolOutput> {
    const resolved = await this.remember(this.resolve(url, query, false));
    if (!("chat" in resolved)) return { text: resolved.text, isError: true, chat: null };
    const chat = toChat(resolved.chat);
    const result = await this.remember(
      this.exclusive(async () => {
        const read = await (await this.ready(url)).evaluate<{
          auth: boolean;
          loaded: number;
          messages: { at: number | null; from: string | null; mine: boolean; text: string; forwarded: boolean; reply: boolean }[];
          unreadBefore: number;
          unreadAfter: number;
          stealthSkipped: number;
        }>(READ_CHAT(chat.id, last, true), 60_000);
        if (read.auth) await this.sessionEnded(url);
        return read;
      }),
    );
    const brief = { id: chat.id, name: chat.name, kind: chat.kind };
    const head = `Chat: ${quoted(chat.name)} (${chat.kind}).`;
    const tail = [
      result.stealthSkipped ? `Disappearing messages left out: ${result.stealthSkipped}.` : null,
      result.unreadBefore ? (result.unreadAfter >= result.unreadBefore ? "The chat stays unread for the user." : "The client marked the chat as read.") : null,
    ];
    if (!result.messages.length) {
      return { text: [`${head} No messages loaded: the chat is empty, or the client did not get them in time.`, ...tail].filter(Boolean).join("\n"), isError: false, chat: brief };
    }
    const lines = result.messages.map((message) => {
      const marks = [message.forwarded ? "forwarded" : null, message.reply ? "reply" : null].filter(Boolean).join(", ");
      const who = message.mine ? "Me" : oneLine(message.from ?? "Someone");
      return `[${clock(message.at)}] ${who}${marks ? ` (${marks})` : ""}: ${indentedLines(message.text)}`;
    });
    return { text: [UNTRUSTED_NOTE, `${head} The last ${result.messages.length} messages:`, dataBlock("messages", lines.join("\n")), ...tail].filter(Boolean).join("\n"), isError: false, chat: brief };
  }

  private async toolSend(url: string, query: string, text: string, lang: Lang | undefined, signal?: AbortSignal, rehearse = false): Promise<ToolOutput> {
    const resolved = await this.remember(this.resolve(url, query, true));
    if (!("chat" in resolved)) return { text: `Not sent. ${resolved.text}`, isError: true, chat: null };
    const chat = toChat(resolved.chat);
    const brief = { id: chat.id, name: chat.name, kind: chat.kind };
    const name = quoted(chat.name);
    const body = text.replace(/\r\n?/g, "\n").trim();
    if (!body) return { text: "Not sent: the text is empty.", isError: true, chat: brief };
    const refusal = windowRefusal(body);
    if (refusal) return { text: `Not sent. ${refusal}`, isError: true, chat: brief };
    const recent = this.lastSent;
    if (recent && recent.chatId === chat.id && recent.text === body && Date.now() - recent.at < DUPLICATE_WINDOW_MS) {
      return { text: `Not sent: the same text went to ${name} ${Math.round((Date.now() - recent.at) / 1000)} s ago.`, isError: true, chat: brief };
    }
    const answer = await this.confirmer.confirm({ chat: chat.name, kind: chat.kind, members: chat.members, person: chat.person, text: body }, signal, lang);
    if (!answer.ok) return { text: answer.message, isError: true, chat: brief };
    await this.remember(this.exclusive(() => this.typeAndSend(url, chat, body, rehearse)));
    if (rehearse) return { text: `Rehearsed for ${name}: the field took the text exactly and was cleared. Nothing was sent.`, isError: false, chat: brief };
    this.lastSent = { chatId: chat.id, text: body, at: Date.now() };
    return { text: `Sent to ${name} (${chat.kind}).`, isError: false, chat: brief };
  }

  /**
   * An answer in the thread under a message: the message is found by a piece of its text, the
   * person to mention among the people of the chat, and only one of each counts. The window shows
   * the chat, the message, the person and the text before anything is typed.
   */
  private async toolReply(url: string, call: Extract<ToolCall, { tool: "reply" }>, signal?: AbortSignal, rehearse = false): Promise<ToolOutput> {
    const resolved = await this.remember(this.resolve(url, call.chat, true));
    if (!("chat" in resolved)) return { text: `Not sent. ${resolved.text}`, isError: true, chat: null };
    const chat = toChat(resolved.chat);
    const brief = { id: chat.id, name: chat.name, kind: chat.kind };
    const name = quoted(chat.name);
    const body = call.text.replace(/\r\n?/g, "\n").trim();
    if (!body) return { text: "Not sent: the text is empty.", isError: true, chat: brief };
    const refusal = windowRefusal(body);
    if (refusal) return { text: `Not sent. ${refusal}`, isError: true, chat: brief };
    const found = await this.remember(
      this.exclusive(async () => {
        const result = await (await this.ready(url)).evaluate<Found>(FIND_MESSAGE(chat.id, call.message), 150_000);
        if (result.auth) await this.sessionEnded(url);
        return result;
      }),
    );
    if (found.missing) return { text: tagged("not-in-directory", `Not sent: the client does not have ${name} now. Update the directory and try again.`), isError: true, chat: brief };
    if (found.total !== 1) {
      if (!found.total) {
        return { text: `Not sent: none of the last ${found.loaded} messages of ${name} holds ${quoted(call.message)}. Pass a piece of the message as it is written there, or ask the user.`, isError: true, chat: brief };
      }
      const lines = found.hits.map((hit) => `[${clock(hit.at)}] ${hit.mine ? "Me" : oneLine(hit.from ?? "Someone")}: ${oneLine(hit.preview, 140)}${hit.threads.length ? "" : "  (no thread)"}`);
      return {
        text: [UNTRUSTED_NOTE, `Not sent: ${found.total} messages of ${name} hold ${quoted(call.message)}. Ask the user which one, then pass a longer piece of its text:`, dataBlock("messages", lines.join("\n"))].join("\n"),
        isError: true,
        chat: brief,
      };
    }
    const hit = found.hits[0]!;
    if (!hit.syncId || hit.threads.length !== 1) {
      const why = hit.threads.length
        ? "the client ties several threads to this message, so it is not clear which one gets the answer."
        : "this message has no thread yet, and a thread cannot be started here. Answer in the chat with messenger_send, or ask the user to start the thread in the client.";
      return { text: `Not sent: ${why}`, isError: true, chat: brief };
    }
    const threadId = hit.threads[0]!;
    let person: ChatPerson | null = null;
    if (call.mention) {
      const picked = pickPerson(call.mention, found.people);
      if ("text" in picked) return { text: `Not sent. ${picked.text}`, isError: true, chat: brief };
      person = picked.person;
    }
    const recent = this.lastSent;
    if (recent && recent.chatId === threadId && recent.text === body && Date.now() - recent.at < DUPLICATE_WINDOW_MS) {
      return { text: `Not sent: the same text went to this thread ${Math.round((Date.now() - recent.at) / 1000)} s ago.`, isError: true, chat: brief };
    }
    const mention = person ? { name: person.name, position: person.position, department: person.department, email: person.email } : null;
    const answer = await this.confirmer.confirm(
      { chat: chat.name, kind: chat.kind, members: chat.members, person: chat.person, text: body, thread: { from: hit.from, at: hit.at, preview: hit.preview }, mention },
      signal,
      call.lang,
    );
    if (!answer.ok) return { text: answer.message, isError: true, chat: brief };
    const done = await this.remember(this.exclusive(() => this.typeReply(url, chat, { syncId: hit.syncId!, threadId }, person, found.people, body, rehearse)));
    const whose = hit.mine ? "your message" : `the message of ${quoted(hit.from ?? "someone")}`;
    if (rehearse) return { text: `Rehearsed for the thread under ${whose} in ${name}: the field took the text${person ? " and the mention" : ""} exactly and was cleared. Nothing was sent.`, isError: false, chat: brief };
    this.lastSent = { chatId: threadId, text: body, at: Date.now() };
    const mentioned = !person ? "" : done.mentioned ? ` with a mention of ${quoted(person.name ?? "")}` : `, but the client did not attach the mention of ${quoted(person.name ?? "")} to it: check the thread`;
    return { text: `Sent to the thread under ${whose} in ${name}${mentioned}.`, isError: false, chat: brief };
  }

  /**
   * Types a text line by line, as a person does: a pasted line break is dropped by the client's
   * field. A new line is Shift+Enter, or Enter when the client sends with Ctrl or Cmd+Enter. After
   * each line break `sent` says whether a message went out; then typing stops.
   */
  private async typeLines(page: Page, text: string, sendButton: string, sent: () => Promise<boolean>): Promise<void> {
    const lines = text.split("\n");
    const newline = /ctrl|cmd|meta/i.test(sendButton) ? 0 : 8;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.insertText(lines[i]!);
      if (i === lines.length - 1) break;
      await page.pressEnter(newline);
      await sleep(400);
      if (await sent()) throw new Error(`The line break (${newline ? "Shift+Enter" : "Enter"}) sent the message after line ${i + 1}, so only part of the text went out. Check the chat before sending again.`);
    }
  }

  /**
   * Clears a field the way a person does: select all, delete. The client's editor keeps its own copy
   * of the text: a field emptied by the page alone shows nothing, while the client still holds the
   * text and keeps it as a draft (seen on the real client). Answers whether the field is empty now.
   */
  private async clearByKeys(page: Page, selector: string, empty: () => Promise<boolean>): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      // No such field any more: the keys would go to whatever has the focus, perhaps another draft.
      if (!(await page.click(selector))) return false;
      await page.pressKey("a", "KeyA", 65, process.platform === "darwin" ? 4 : 2, ["selectAll"]);
      await page.pressKey("Backspace", "Backspace", 8);
      await sleep(500);
      if (await empty()) return true;
    }
    return false;
  }

  /** The thread's marked field. */
  private clearTarget(page: Page, state: () => Promise<ThreadState>): Promise<boolean> {
    return this.clearByKeys(page, TARGET_SELECTOR, async () => {
      const now = await state();
      return !now.composer || (!now.field && !now.inline);
    });
  }

  /** The chat's field; the page's own way only when the keys did not empty it. */
  private async clearComposer(page: Page, state: () => Promise<SendState>): Promise<boolean> {
    if (await this.clearByKeys(page, COMPOSER_SELECTOR(), async () => (await state()).empty)) return true;
    return page.evaluate<boolean>(CLEAR_FIELD, 10_000).catch(() => false);
  }

  /**
   * Opens the thread, puts the mention in through the client's "@" list, types the confirmed text
   * and sends it. The field must be empty first, must hold exactly the mention and the text before
   * the send key and after every key that did not send, and is cleared when a send fails. The answer
   * must show up in the thread and nowhere else.
   */
  private async typeReply(
    url: string,
    chat: Chat,
    target: { syncId: string; threadId: string },
    person: ChatPerson | null,
    people: readonly ChatPerson[],
    body: string,
    rehearse: boolean,
  ): Promise<{ mentioned: boolean | null }> {
    const page = await this.ready(url);
    const name = quoted(chat.name);
    try {
      const opened = await page.evaluate<Opened>(OPEN_THREAD(target.threadId, chat.id, target.syncId), 120_000);
      if (!opened.opened) {
        throw new Error(opened.why === "row" ? `Not sent: the client did not show the message in ${name}, so its thread could not be opened.` : "Not sent: the client did not open the message field of that thread.");
      }
      this.options.diagnose?.(`thread: opened ${opened.opened ? `by ${opened.how}` : "no"}, fields on the page ${opened.composers}, messages loaded ${opened.loaded}, history settled ${opened.settled ? "yes" : "no"}`);
      if (!opened.settled) throw new Error("Not sent: the history of the thread kept loading, so an earlier answer of yours there could be missed.");
      const state = () => page.evaluate<ThreadState>(THREAD_STATE(target.threadId, chat.id, body, person?.huid ?? null));
      const before = await state();
      if (!before.composer) throw new Error("Not sent: the client did not open the message field of that thread.");
      if (before.same) throw new Error("Not sent: the thread already has your message with this text.");
      if (before.field || before.inline) throw new Error("Not sent: the message field of the thread already holds text, perhaps an unfinished draft. Nothing was typed and the field was left as it is.");
      const expected = normalizeText(body);
      // The mention comes first: the field ends with the text, and before it there is only the mention.
      const holds = (now: ThreadState) => (person ? now.field.endsWith(expected) && !now.field.slice(0, now.field.length - expected.length).includes("\n") && now.field.length - expected.length <= 160 : now.field === expected);
      const moved = (now: ThreadState) => now.mine !== before.mine || now.inParent !== before.inParent;
      let typed = false;
      try {
        await page.click(TARGET_SELECTOR);
        await sleep(300);
        if (!(await page.evaluate<boolean>(FOCUS_TARGET))) throw new Error("Not sent: the message field of the thread did not take the focus.");
        typed = true;
        let separator = "";
        if (person) {
          const parts = String(person.name ?? "").split(/[\s,]+/).filter((word) => word.length >= 2);
          let point: { x: number; y: number } | null = null;
          const queries = [...new Set([parts[0], parts[parts.length - 1]].filter((word): word is string => !!word))];
          for (const [n, query] of queries.entries()) {
            await page.evaluate(MARK_PAGE);
            await page.insertText(`@${query}`);
            // The client draws its list a moment after the typing.
            let item: MentionItem | null = null;
            for (let i = 0; i < 8 && !item?.point; i++) {
              await sleep(i ? 500 : 1000);
              item = await page.evaluate<MentionItem>(MENTION_ITEM(person.huid, people.map((p) => p.huid), person.name, people.map((p) => p.name).filter((name): name is string => !!name)));
            }
            this.options.diagnose?.(
              `"@" list, word ${n + 1} of ${queries.length}: people ${item!.people} (by ${item!.by}), the person ${item!.point ? "found" : "not found"}; new elements ${item!.added}, "@" in the field ${item!.fieldHasAt ? "yes" : "no"}, focus in the field ${item!.focused ? "yes" : "no"}`,
            );
            if (item?.point) {
              point = item.point;
              break;
            }
            if (!(await this.clearTarget(page, state))) throw new Error("Not sent: the message field could not be cleared after looking for the person.");
          }
          if (!point) throw new Error(`Not sent: the client's @ list in this thread does not offer ${quoted(person.name ?? "")}.`);
          await page.clickAt(point.x, point.y);
          await sleep(800);
          const placed = await page.evaluate<FieldMention>(FIELD_MENTION(person.huid, person.name));
          if (!placed.mention) throw new Error("Not sent: the client did not put the mention in the field.");
          separator = placed.endsWithSpace ? "" : " ";
        }
        await this.typeLines(page, separator + body, before.sendButton, async () => moved(await state()));
        await sleep(900);
        const ready = await state();
        if (moved(ready)) throw new Error("A message went out while typing. Check the thread before sending again.");
        if (!holds(ready)) throw new Error("Not sent: the message field of the thread does not hold exactly the confirmed text.");
        if (person) {
          const placed = await page.evaluate<FieldMention>(FIELD_MENTION(person.huid, person.name));
          if (!placed.mention) throw new Error("Not sent: the mention is no longer in the field.");
          if (placed.listOpen) throw new Error("Not sent: the client's @ list is still open, and the send key would pick someone from it.");
        }
        if (rehearse) {
          if (!(await this.clearTarget(page, state))) throw new Error("Rehearsed, but the message field could not be cleared, so the text may still be there.");
          return { mentioned: null };
        }
        const ctrlFirst = /ctrl|cmd|meta/i.test(before.sendButton);
        const keys: [string, number][] = ctrlFirst ? [["Ctrl+Enter", 2], ["Cmd+Enter", 4], ["Enter", 0]] : [["Enter", 0], ["Ctrl+Enter", 2], ["Cmd+Enter", 4]];
        for (const [key, modifiers] of keys) {
          await page.pressEnter(modifiers);
          let now = await state();
          for (let i = 0; i < 8; i++) {
            await sleep(500);
            now = await state();
            if (now.inParent !== before.inParent) throw new Error(`A message of yours appeared in ${name} itself rather than in the thread. Check the chat before sending again.`);
            const empty = !now.field && !now.inline;
            if (now.mine > before.mine && empty) return { mentioned: person ? now.lastMentionsPerson === true : null };
            if (empty && i >= 5) throw new Error(`After ${key} the field is empty but the answer is not in the thread yet. Check the thread before sending again.`);
            if (!empty && !holds(now)) throw new Error(`Not sent: the message field changed after ${key}, so it no longer holds exactly the confirmed text.`);
          }
          // Another key could send it twice.
          if (now.mine > before.mine) throw new Error("The thread has a new message, but the field still holds the text too. Check the thread before sending again.");
        }
        throw new Error("Not sent: no send key worked.");
      } catch (error) {
        if (!typed) throw error;
        const cleared = await this.clearTarget(page, state).catch(() => false);
        if (cleared) throw error;
        throw new Error(`${error instanceof Error ? error.message : String(error)} The message field could not be cleared, so the text may still be there.`);
      }
    } finally {
      await page.evaluate(LEAVE_THREAD, 10_000).catch(() => undefined);
    }
  }

  /**
   * Types exactly the confirmed text and sends it. The field must be empty first (what is there may
   * be the person's), must hold exactly this text before the send key and after every key that did
   * not send, and is cleared when a send fails.
   */
  private async typeAndSend(url: string, chat: Chat, body: string, rehearse = false): Promise<void> {
    const page = await this.ready(url);
    const name = quoted(chat.name);
    const opened = await page.evaluate<{ header: string | null; composer: boolean }>(OPEN_CHAT(chat.id), 45_000);
    const headerMatches = !!opened.header && (lookKey(opened.header) === lookKey(chat.name) || score(chat.name, opened.header) >= 0.9);
    if (!headerMatches) throw new Error(`Not sent: the client opened a different chat than ${name}.`);
    if (!opened.composer) throw new Error(`Not sent: ${name} does not take messages from the user (a channel, or a chat to join first).`);
    const state = () => page.evaluate<SendState>(SEND_STATE(chat.id, body));
    const before = await state();
    if (!before.empty) throw new Error(`Not sent: the message field of ${name} already holds text, perhaps an unfinished draft. Nothing was typed and the field was left as it is.`);
    try {
      await page.click(COMPOSER_SELECTOR());
      await sleep(300);
      await this.typeLines(page, body, before.sendButton, async () => (await state()).own > before.own);
      await sleep(700);
      if (!(await state()).exact) throw new Error("Not sent: the message field does not hold exactly the confirmed text.");
      if (rehearse) {
        if (!(await this.clearComposer(page, state))) throw new Error("Rehearsed, but the message field could not be cleared, so the text may still be there.");
        return;
      }
      // The send key from the client's settings first, then the others; each only while the field holds the text.
      const ctrlFirst = /ctrl|cmd|meta/i.test(before.sendButton);
      const keys: [string, number][] = ctrlFirst ? [["Ctrl+Enter", 2], ["Cmd+Enter", 4], ["Enter", 0]] : [["Enter", 0], ["Ctrl+Enter", 2], ["Cmd+Enter", 4]];
      for (const [key, modifiers] of keys) {
        await page.pressEnter(modifiers);
        let now = await state();
        for (let i = 0; i < 8; i++) {
          await sleep(500);
          now = await state();
          if (now.mine > before.mine && now.empty) return;
          if (now.empty && i >= 5) throw new Error(`After ${key} the field is empty but the message is not in the chat yet. Check the chat before sending again.`);
          if (!now.empty && !now.exact) throw new Error(`Not sent: the message field changed after ${key}, so it no longer holds exactly the confirmed text.`);
        }
        // Another key could send it twice.
        if (now.mine > before.mine) throw new Error("The chat has a new message with this text, but the field still holds it too. Check the chat before sending again.");
      }
      throw new Error("Not sent: no send key worked.");
    } catch (error) {
      const cleared = await this.clearComposer(page, state).catch(() => false);
      if (cleared) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)} The message field could not be cleared, so the text may still be there.`);
    }
  }
}

/** The English text behind its code, when the panel has a translation for it (src/shared/errors.ts). */
function forPanel(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (error instanceof SignInNeeded) return tagged("sign-in", text);
  if (error instanceof Busy) return tagged("busy", text);
  if (error instanceof BrowserError && error.code === "unreachable") return tagged("unreachable", text);
  if (error instanceof BrowserError && error.code === "no-browser") return tagged("no-browser", text);
  return text;
}

function describe(chat: Chat, matchScore?: number): string {
  const p = chat.person;
  const who = p ? [p.position, p.department].filter((part): part is string => !!part).map((part) => oneLine(part)).join(", ") : "";
  return [
    `[${chat.id}]`,
    chat.kind,
    oneLine(chat.name),
    who ? `— ${who}` : null,
    chat.kind === "group" || chat.kind === "channel" ? `${chat.members} members` : null,
    chat.unread ? `unread ${chat.unread}` : null,
    matchScore !== undefined ? `match ${matchScore.toFixed(2)}` : null,
  ]
    .filter(Boolean)
    .join("  ");
}

/** Text as the page compares it (NORMALIZE in page.ts): line ends, zero-width marks, no-break spaces and empty lines do not count. */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(new RegExp(`[${String.fromCharCode(0x200b, 0xfeff)}]`, "g"), "")
    .replace(new RegExp(String.fromCharCode(0xa0), "g"), " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** The person to mention: an email address only as it is, a name only when one person of the chat clearly fits. */
function pickPerson(query: string, people: readonly ChatPerson[]): { person: ChatPerson } | { text: string } {
  const wanted = query.trim();
  if (wanted.includes("@")) {
    const hits = people.filter((p) => p.email && p.email.toLowerCase() === wanted.toLowerCase());
    if (hits.length === 1) return { person: hits[0]! };
    return { text: hits.length ? `Several people of the chat have the address ${quoted(wanted)}.` : `Nobody among the people of the chat has the address ${quoted(wanted)}. Ask the user whom to mention.` };
  }
  const found = findBest(wanted, people.filter((p) => p.name), { limit: 3, strict: true });
  const top = found.matches[0];
  if (top && !found.ambiguous && top.score >= 0.9) return { person: top.entry };
  if (!found.matches.length) return { text: `Nobody among the people of the chat matches ${quoted(wanted)}. Ask the user whom to mention.` };
  const lines = found.matches.map((match) => {
    const p = match.entry;
    const job = [p.position, p.department].filter((part): part is string => !!part).map((part) => oneLine(part)).join(", ");
    return [oneLine(p.name ?? ""), job ? `— ${job}` : null, p.email ? oneLine(p.email) : null, `match ${match.score.toFixed(2)}`].filter(Boolean).join("  ");
  });
  return { text: [UNTRUSTED_NOTE, `${quoted(wanted)} does not name one person of the chat clearly. Ask the user which one, then pass the email address:`, dataBlock("people", lines.join("\n"))].join("\n") };
}

/** Local time of this machine: 2026-11-01 14:05. */
function clock(ms: number | null): string {
  if (!ms) return "----------  --:--";
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
