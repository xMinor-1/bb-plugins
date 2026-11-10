// Mail on the person's machine: the connection, short message refs, drafts
// prepared through bb, and the agent tools' answers.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  AuthMode,
  MeetingDetails,
  MeetingFields,
  MeetingInput,
  MeetingProposal,
  MeetingResult,
  MeetingScope,
  CalendarOutput,
  ConnectionStatus,
  Lang,
  Draft,
  DraftInput,
  Folder,
  ListInput,
  ListOutput,
  MailAddress,
  MailMessage,
  MessageAttachment,
  MessageSummary,
  People,
  SendResult,
  ToolInput,
  ToolOutput,
} from "../../contract.js";
import { ATTACHMENT_MAX_BYTES, CALENDAR_MAX_DAYS, CALENDAR_MAX_EVENTS, FREE_TIME_MAX_DAYS } from "../shared/limits.js";
import { blocksTime, busyKind, checkPeriod, eventId, fixedOffset, formatAvailability, formatCommonTime, formatEvents, formatFreeTime, freeSlots, freeStretches, minutesOf, parseWhen, rangeOf, sameLocalDay, spanText, toEvent, zoneOffset, type Offset, type PersonBusy } from "./calendar.js";
import { everyone, formatProposal, missingFrom, proposalView, revisionOf, sameList, uniqueAddresses, type ProposalEntry } from "./meetings.js";
import type { MeetingChanges } from "./ews/soap.js";
import { normalizeText } from "../shared/mail-text.js";
import { isAddress } from "../shared/recipients.js";
import { isTimeZone } from "../shared/zone.js";
import { oneAtATime, systemConfirmer, type MeetingSummary, type SendConfirmer, type SendSummary } from "./confirm.js";
import { curlTransport, type HttpAuth, type Transport } from "./curl.js";
import { EwsClient, normalizeEwsUrl } from "./ews/client.js";
import { EwsError } from "./ews/parse.js";
import type { ParsedAttachment, ParsedMessage, ParsedSummary } from "./ews/parse.js";
import { attachmentText } from "./extract.js";
import type { Address, FolderName, ItemRef } from "./ews/soap.js";
import { readJson, removeFile, serial, writeJson } from "./files.js";
import { formatAttachment, formatConversation, formatDraft, formatList, formatMessage, formatPeople } from "./format.js";
import { openSecretStore, type SecretStore } from "./secret-store.js";
import { describe, forPanel, UserError } from "./errors.js";
import { accountName, SignInGate, type Refusal, type RefusalStore } from "./signin.js";

const EWS_FOLDER: Record<Folder, FolderName> = { inbox: "inbox", sent: "sentitems", drafts: "drafts", deleted: "deleteditems" };
const FOLDER_TITLE: Record<Folder, string> = { inbox: "Inbox", sent: "Sent Items", drafts: "Drafts", deleted: "Deleted Items" };
const PASSWORD = "password";
/** Message refs and calendar event ids together. */
const MAX_REFS = 10_000;
const MAX_PROPOSALS = 100;
/** A meeting proposed may last two weeks at most. */
const MEETING_MAX_MS = 14 * 86_400_000;
const MAX_DRAFTS = 100;
/** Pictures inside an HTML message: each and all together, so a message cannot make the panel fetch megabytes. */
const INLINE_IMAGE_MAX_BYTES = 1_500_000;
const INLINE_IMAGES_MAX_BYTES = 6_000_000;
const INLINE_IMAGES_MAX = 30;
const CONVERSATION_MAX = 50;
/** Free time is looked for in a month at most. */
/** People shown for one search: enough to choose from, few enough to read. */
export const PEOPLE_MAX = 25;

const plainAttachment = (a: ParsedAttachment) => ({ name: a.name, size: a.size });
const numbered = (list: readonly ParsedAttachment[]): MessageAttachment[] =>
  list.map((a, n) => ({ index: n + 1, name: a.name, size: a.size, contentType: a.contentType, kind: a.kind, inline: a.isInline, contentId: a.contentId }));

interface Connection {
  url: string;
  auth: AuthMode;
  user: string | null;
  lastCheck: { ok: boolean; at: number; message: string } | null;
  /** Changes with every password typed in, so a refused password is never retried on its own. */
  passwordVersion?: string | null;
  /** The address and login the stored password was entered for; it is used for nothing else. */
  passwordFor?: string | null;
}

const bindingOf = (url: string, user: string) => `${url}\n${user}`;

interface DraftEntry {
  id: string;
  itemId: string;
  kind: Draft["kind"];
  source: Draft["source"];
  threadId: string | null;
  createdAt: number;
  text: string;
  replyTo: { ref: string; itemId: string; subject: string; from: MailAddress | null } | null;
}


export interface MailServiceOptions {
  readonly dataDir: string;
  readonly transport?: Transport;
  readonly secrets?: SecretStore;
  readonly platform?: NodeJS.Platform;
  /** For tests: minutes east of UTC used in agent answers, whatever zone a call names. */
  readonly utcOffsetMinutes?: number;
  /** The system window that confirms each send. Tests pass a stand-in. */
  readonly confirm?: SendConfirmer;
  /** Plain http to this machine, for a test server only. */
  readonly allowLocalHttp?: boolean;
  /** For tests: the clock. */
  readonly now?: () => number;
}

/** Short, stable names for Exchange item ids, which run to 150+ characters. */
export function refFor(itemId: string): string {
  return `m${createHash("sha256").update(itemId).digest("base64url").replace(/[-_]/g, "").slice(0, 10).toLowerCase()}`;
}


/** "Name <email>" or "email". */
export function parseRecipient(input: string): Address {
  const text = input.trim();
  const angle = /^(.*)<([^<>]+)>$/.exec(text);
  const email = (angle ? angle[2]! : text).trim();
  const name = angle ? angle[1]!.trim().replace(/^"(.*)"$/, "$1").trim() : "";
  if (!isAddress(email)) throw new UserError(`"${input}" is not an email address`);
  return { name: name || null, email };
}

const toAddress = (a: Address): MailAddress => ({ name: a.name, email: a.email });

export class MailService {
  private readonly dataDir: string;
  private readonly transport: Transport;
  private readonly secrets: SecretStore;
  private readonly platform: NodeJS.Platform;
  private readonly offset: number | undefined;
  private readonly confirmer: SendConfirmer;
  private readonly allowLocalHttp: boolean;
  private readonly now: () => number;
  private readonly gate: SignInGate;
  private readonly writeDrafts = serial();
  private readonly writeRefs = serial();
  private readonly writeSignIn = serial();
  private readonly writeMeetings = serial();
  private readonly confirmingMeetings = new Set<string>();
  private refs: Map<string, string> | null = null;
  private refsDirty: NodeJS.Timeout | null = null;

  constructor(options: MailServiceOptions) {
    this.dataDir = options.dataDir;
    this.transport = options.transport ?? curlTransport({ platform: options.platform });
    this.secrets = options.secrets ?? openSecretStore("auto", options.platform);
    this.platform = options.platform ?? process.platform;
    this.offset = options.utcOffsetMinutes;
    this.confirmer = oneAtATime(options.confirm ?? systemConfirmer(this.platform));
    this.allowLocalHttp = options.allowLocalHttp === true;
    this.now = options.now ?? Date.now;
    this.gate = new SignInGate(this.refusalStore(), this.now);
  }

  close(): void {
    if (this.refsDirty) {
      clearTimeout(this.refsDirty);
      this.refsDirty = null;
      void this.flushRefs();
    }
  }

  // ---------------------------------------------------------------- connection

  private connectionFile = () => join(this.dataDir, "connection.json");
  /** Refused sign-ins per login. Not mail, and kept through Disconnect: forgetting it would lift the pause. */
  private signInFile = () => join(this.dataDir, "signin.json");
  private draftsFile = () => join(this.dataDir, "drafts.json");
  private refsFile = () => join(this.dataDir, "refs.json");

  private readConnection = () => readJson<Connection>(this.connectionFile());

  private refusalStore(): RefusalStore {
    const read = async () => (await readJson<Record<string, Refusal>>(this.signInFile())) ?? {};
    return {
      get: async (login) => (await read())[login] ?? null,
      set: (login, refusal) =>
        this.writeSignIn(async () => {
          const all = await read();
          if (refusal) all[login] = refusal;
          else delete all[login];
          // A day-old refusal no longer counts towards any lockout window.
          for (const [name, entry] of Object.entries(all)) if (this.now() - entry.at > 86_400_000) delete all[name];
          await writeJson(this.signInFile(), all);
        }),
    };
  }

  private normalizeUrl(input: string): string {
    return normalizeEwsUrl(input, { allowLocalHttp: this.allowLocalHttp });
  }

  async status(): Promise<ConnectionStatus> {
    const connection = await this.readConnection();
    let curl: ConnectionStatus["curl"] = null;
    let curlError: string | null = null;
    try {
      const info = await this.transport.info();
      const has = (name: string) => info.features.some((feature) => feature.toLowerCase() === name.toLowerCase());
      curl = { path: info.path, version: info.version, negotiate: has("SPNEGO") || has("GSS-API") || has("Kerberos"), ntlm: has("NTLM") };
    } catch (error) {
      curlError = forPanel(error);
    }
    const password = connection?.auth === "password" && connection.user;
    const hasPassword = password
      ? connection.passwordFor === bindingOf(connection.url, connection.user!) && (await this.secrets.has(PASSWORD).catch(() => false))
      : false;
    const pause = password ? await this.gate.status(accountName(connection.user!)) : { blocked: null, retryAt: null };
    return {
      platform: this.platform,
      curl,
      curlError,
      url: connection?.url ?? null,
      auth: connection?.auth ?? null,
      user: connection?.user ?? null,
      hasPassword,
      passwordStore: this.secrets.label,
      blocked: pause.blocked,
      retryAt: pause.retryAt,
      lastCheck: connection?.lastCheck ?? null,
    };
  }

  async saveConnection(input: { url: string; auth: AuthMode; user?: string; password?: string }): Promise<ConnectionStatus> {
    const url = this.normalizeUrl(input.url);
    const previous = await this.readConnection();
    let user: string | null = null;
    let passwordVersion: string | null = null;
    let passwordFor: string | null = null;
    if (input.auth === "password") {
      user = (input.user ?? "").trim();
      if (!user) throw new UserError("Enter the login, for example DOMAIN\\name or name@company.com", "login-required");
      passwordFor = bindingOf(url, user);
      if (input.password) {
        await this.secrets.set(PASSWORD, Buffer.from(input.password, "utf8").toString("base64"));
        passwordVersion = randomBytes(6).toString("hex");
      } else {
        // A password belongs to the address and login it was typed for: never send it to another server or as another login.
        const kept = previous?.auth === "password" && previous.passwordFor === passwordFor && (await this.secrets.has(PASSWORD));
        if (!kept) {
          const hadOne = previous?.auth === "password";
          await this.secrets.delete(PASSWORD).catch(() => false);
          throw hadOne
            ? new UserError("The saved password was for the previous address or login, so bb removed it. Enter the password for this one.", "password-other-account")
            : new UserError("Enter the password", "password-required");
        }
        passwordVersion = previous.passwordVersion ?? null;
      }
    } else {
      await this.secrets.delete(PASSWORD).catch(() => false);
    }
    const sameTarget = previous && previous.url === url && previous.auth === input.auth && previous.user === user && !input.password;
    await writeJson(this.connectionFile(), {
      url,
      auth: input.auth,
      user,
      lastCheck: sameTarget ? previous.lastCheck : null,
      passwordVersion,
      passwordFor,
    } satisfies Connection);
    return this.status();
  }

  async forget(): Promise<ConnectionStatus> {
    await this.secrets.delete(PASSWORD).catch(() => false);
    await removeFile(this.connectionFile());
    await this.writeDrafts(() => removeFile(this.draftsFile()));
    await this.writeMeetings(() => removeFile(this.meetingsFile()));
    await this.writeRefs(async () => {
      this.refs = new Map();
      await removeFile(this.refsFile());
    });
    return this.status();
  }

  private async client(options: { retry?: boolean } = {}): Promise<EwsClient> {
    const connection = await this.readConnection();
    if (!connection) throw new UserError("Mail is not connected on this machine yet. Connect it in Mail → Settings in the bb sidebar.", "not-connected");
    const url = this.normalizeUrl(connection.url);
    if (connection.auth === "negotiate") return new EwsClient({ url, auth: { kind: "negotiate" }, transport: this.transport });
    if (!connection.user || connection.passwordFor !== bindingOf(connection.url, connection.user)) {
      await this.secrets.delete(PASSWORD).catch(() => false);
      throw new UserError("The mail password is missing on this machine. Enter it again in Mail → Settings in the bb sidebar.", "password-missing");
    }
    const account = { login: accountName(connection.user), version: connection.passwordVersion ?? null, url, retry: options.retry === true };
    // Fail before reading the password; the gate checks again at the moment it would sign in.
    const paused = await this.gate.check(account);
    if (paused) throw paused;
    const stored = await this.secrets.get(PASSWORD);
    if (!stored) throw new UserError("The mail password is missing on this machine. Enter it again in Mail → Settings in the bb sidebar.", "password-missing");
    const auth: HttpAuth = { kind: "ntlm", user: connection.user, password: Buffer.from(stored, "base64").toString("utf8") };
    return new EwsClient({ url, auth, transport: this.gate.transport(this.transport, account) });
  }

  async check(retry = false, signal?: AbortSignal): Promise<{ ok: boolean; message: string; unread: number | null }> {
    const connection = await this.readConnection();
    if (!connection) return { ok: false, message: forPanel(new UserError("Mail is not connected yet.", "not-connected")), unread: null };
    let result: { ok: boolean; message: string; unread: number | null };
    try {
      const counts = await (await this.client({ retry })).folderCounts("inbox", signal);
      result = { ok: true, message: `Connected. Inbox: ${counts.total} messages, ${counts.unread} unread.`, unread: counts.unread };
    } catch (error) {
      // Only the panel reads this, now and as the saved last check.
      result = { ok: false, message: forPanel(error), unread: null };
    }
    const latest = await this.readConnection();
    if (latest && latest.url === connection.url && latest.auth === connection.auth && latest.user === connection.user) {
      await writeJson(this.connectionFile(), { ...latest, lastCheck: { ok: result.ok, at: this.now(), message: result.message } });
    }
    return result;
  }

  // ---------------------------------------------------------------------- refs

  private async refMap(): Promise<Map<string, string>> {
    if (!this.refs) {
      const stored = (await readJson<[string, string][]>(this.refsFile())) ?? [];
      this.refs ??= new Map(Array.isArray(stored) ? stored : []);
    }
    return this.refs;
  }

  private async remember(itemId: string, ref = refFor(itemId)): Promise<string> {
    const map = await this.refMap();
    if (map.get(ref) !== itemId) {
      map.delete(ref);
      map.set(ref, itemId);
      while (map.size > MAX_REFS) map.delete(map.keys().next().value!);
      this.refsDirty ??= setTimeout(() => {
        this.refsDirty = null;
        void this.flushRefs();
      }, 500);
    }
    return ref;
  }

  private flushRefs() {
    return this.writeRefs(async () => {
      if (this.refs) await writeJson(this.refsFile(), [...this.refs.entries()]);
    });
  }

  private async itemIdOf(ref: string): Promise<string> {
    const itemId = (await this.refMap()).get(ref.trim());
    if (!itemId) throw new UserError(`Unknown message ref "${ref}". List or search messages first and use a [ref] from the result.`);
    return itemId;
  }

  private async summary(item: ParsedSummary): Promise<MessageSummary> {
    return {
      ref: await this.remember(item.item.id),
      kind: item.kind,
      subject: item.subject,
      from: item.from ? toAddress(item.from) : null,
      displayTo: item.displayTo,
      received: item.received,
      isRead: item.isRead,
      hasAttachments: item.hasAttachments,
      preview: item.preview,
    };
  }

  private async message(item: ParsedMessage): Promise<MailMessage> {
    return {
      ...(await this.summary(item)),
      to: item.to.map(toAddress),
      cc: item.cc.map(toAddress),
      sent: item.sent,
      body: normalizeText(item.body),
      html: item.html,
      bodyFormat: item.bodyFormat,
      attachments: numbered(item.attachments),
    };
  }

  // ---------------------------------------------------------------------- mail

  async list(input: ListInput, signal?: AbortSignal): Promise<ListOutput> {
    const client = await this.client();
    const folder = input.folder ?? "inbox";
    const offset = input.offset ?? 0;
    const query = input.query?.trim() || undefined;
    const [found, counts] = await Promise.all([
      client.find({ folder: EWS_FOLDER[folder], offset, limit: input.limit ?? 30, unreadOnly: input.unreadOnly, query }, signal),
      folder === "inbox" && offset === 0 && !query ? client.folderCounts("inbox", signal).catch(() => null) : Promise.resolve(null),
    ]);
    const messages: MessageSummary[] = [];
    for (const item of found.items) messages.push(await this.summary(item));
    return { messages, total: found.total, more: !found.last, unread: counts?.unread ?? null };
  }

  /** `html` for the panel: the HTML body too, for its sanitized view. Agents get text only. */
  async read(ref: string, markRead: boolean, signal?: AbortSignal, options: { html?: boolean } = {}): Promise<MailMessage> {
    const client = await this.client();
    const id = await this.itemIdOf(ref);
    const item = await client.get({ id }, signal, { html: options.html === true });
    if (markRead && !item.isRead) {
      await client.markRead({ id }, true, signal).catch(() => undefined);
      return this.message({ ...item, isRead: true });
    }
    return this.message(item);
  }

  /** The messages of the conversation `ref` belongs to, in Inbox and Sent Items, oldest first. */
  async conversation(ref: string, signal?: AbortSignal): Promise<{ messages: MessageSummary[] }> {
    const client = await this.client();
    const item = await client.get({ id: await this.itemIdOf(ref) }, signal);
    if (!item.conversationId) return { messages: [await this.summary(item)] };
    const seen = new Set<string>();
    const found: ParsedSummary[] = [];
    for (const folder of ["inbox", "sentitems"] as const) {
      const page = await client.find({ folder, offset: 0, limit: CONVERSATION_MAX, conversationId: item.conversationId }, signal);
      for (const summary of page.items) {
        if (seen.has(summary.item.id)) continue;
        seen.add(summary.item.id);
        found.push(summary);
      }
    }
    if (!seen.has(item.item.id)) found.push(item);
    found.sort((a, b) => (a.received ?? "").localeCompare(b.received ?? ""));
    const messages: MessageSummary[] = [];
    for (const summary of found.slice(-CONVERSATION_MAX)) messages.push(await this.summary(summary));
    return { messages };
  }

  private async fileAttachment(ref: string, index: number, signal?: AbortSignal) {
    const client = await this.client();
    const item = await client.get({ id: await this.itemIdOf(ref) }, signal);
    const attachment = item.attachments[index - 1];
    if (!attachment) throw new UserError(`Message ${ref} has no attachment ${index}. mail_read lists them with their numbers.`);
    if (attachment.kind !== "file") throw new UserError(`${attachment.name} is an attached message or a link to a file elsewhere: it opens in Outlook only.`);
    if (attachment.size !== null && attachment.size > ATTACHMENT_MAX_BYTES) {
      throw new UserError(`${attachment.name} is larger than ${ATTACHMENT_MAX_BYTES / 1048576} MB, so it stays in Outlook: open it there.`);
    }
    const file = await client.attachment(attachment.id, signal);
    if (file.content.length > ATTACHMENT_MAX_BYTES) throw new UserError(`${attachment.name} is larger than ${ATTACHMENT_MAX_BYTES / 1048576} MB, so it stays in Outlook: open it there.`);
    return { name: attachment.name, contentType: file.contentType ?? attachment.contentType, content: file.content };
  }

  /** A file attached to a message, for the panel to open or save. */
  async attachment(ref: string, index: number, signal?: AbortSignal): Promise<{ name: string; contentType: string | null; size: number; base64: string }> {
    const file = await this.fileAttachment(ref, index, signal);
    return { name: file.name, contentType: file.contentType, size: file.content.length, base64: file.content.toString("base64") };
  }

  /** The pictures an HTML message shows inside its text, as data: URLs. Only images, and only up to the limits above. */
  async inlineImages(ref: string, signal?: AbortSignal): Promise<{ images: { contentId: string; dataUrl: string }[]; skipped: number }> {
    const client = await this.client();
    const item = await client.get({ id: await this.itemIdOf(ref) }, signal);
    const wanted = item.attachments.filter((a) => a.kind === "file" && a.contentId);
    const images: { contentId: string; dataUrl: string }[] = [];
    let total = 0;
    let skipped = 0;
    for (const attachment of wanted) {
      if (images.length >= INLINE_IMAGES_MAX || (attachment.size ?? 0) > INLINE_IMAGE_MAX_BYTES || total + (attachment.size ?? 0) > INLINE_IMAGES_MAX_BYTES) {
        skipped++;
        continue;
      }
      const file = await client.attachment(attachment.id, signal);
      const type = imageType(file.content);
      if (!type || file.content.length > INLINE_IMAGE_MAX_BYTES || total + file.content.length > INLINE_IMAGES_MAX_BYTES) {
        skipped++;
        continue;
      }
      total += file.content.length;
      images.push({ contentId: attachment.contentId!, dataUrl: `data:${type};base64,${file.content.toString("base64")}` });
    }
    return { images, skipped };
  }

  // -------------------------------------------------------------------- drafts

  // ------------------------------------------------------------------ calendar

  /**
   * The zone a call names (the plugin's setting, Europe/Moscow by default),
   * this machine's when it names none, or the fixed offset tests give.
   */
  private zone(timeZone?: string): Offset {
    if (this.offset !== undefined) return fixedOffset(this.offset);
    return zoneOffset(timeZone && isTimeZone(timeZone) ? timeZone : null);
  }

  /** Events between two ISO moments, recurring meetings expanded, for the panel and other plugins. */
  async calendar(start: string, end: string, signal?: AbortSignal): Promise<CalendarOutput> {
    const from = Date.parse(start);
    const to = Date.parse(end);
    checkPeriod(from, to, CALENDAR_MAX_DAYS);
    return this.readCalendar(from, to, signal);
  }

  /**
   * Events of the user's calendar, or with `mailbox` of another person's, read
   * only: their ids are not remembered, so no proposal can name them.
   */
  private async readCalendar(from: number, to: number, signal?: AbortSignal, mailbox?: string): Promise<CalendarOutput> {
    const client = await this.client();
    const { events, last } = await client.calendar({ start: new Date(from).toISOString(), end: new Date(to).toISOString(), max: CALENDAR_MAX_EVENTS, mailbox }, signal);
    // The ids the panel and agents name events by, for proposals: the user's own calendar only.
    if (!mailbox) for (const event of events) await this.remember(event.item.id, eventId(event.item.id));
    return {
      // A CalendarView gives occurrences, never the recurring master itself; anything else that slips in is left out.
      events: events
        .filter((event) => event.type !== "RecurringMaster" && !Number.isNaN(Date.parse(event.start)) && !Number.isNaN(Date.parse(event.end)))
        .map(toEvent)
        .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)),
      more: !last,
    };
  }

  // -------------------------------------------------------------- address book

  /** People whose name or address starts like `query`, each address once. */
  async findPeople(query: string, signal?: AbortSignal): Promise<People> {
    const text = query.trim();
    if (text.length < 2) return { people: [], more: false };
    const { people, total } = await (await this.client()).resolveNames(text, signal);
    const seen = new Set<string>();
    const unique = people.filter((person) => {
      const key = person.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { people: unique.slice(0, PEOPLE_MAX), more: unique.length > PEOPLE_MAX || total > people.length };
  }

  private readDrafts = async () => (await readJson<DraftEntry[]>(this.draftsFile())) ?? [];

  private async view(client: EwsClient, entry: DraftEntry, signal?: AbortSignal): Promise<Draft | null> {
    let item: ParsedMessage;
    try {
      item = await client.get({ id: entry.itemId }, signal);
    } catch (error) {
      // Sent or deleted in Outlook: the draft is no longer ours to show.
      if (error instanceof EwsError && error.code === "ErrorItemNotFound") {
        await this.writeDrafts(async () => writeJson(this.draftsFile(), (await this.readDrafts()).filter((d) => d.id !== entry.id)));
        return null;
      }
      throw error;
    }
    if (!item.item.changeKey) throw new EwsError("BadResponse", "Exchange did not return the draft's version");
    return {
      id: entry.id,
      kind: entry.kind,
      source: entry.source,
      threadId: entry.threadId,
      createdAt: entry.createdAt,
      subject: item.subject,
      to: item.to.map(toAddress),
      cc: item.cc.map(toAddress),
      bcc: item.bcc.map(toAddress),
      attachments: item.attachments.map(plainAttachment),
      bodyFormat: item.bodyFormat,
      body: item.body,
      text: entry.text,
      replyTo: entry.replyTo ? { ref: entry.replyTo.ref, subject: entry.replyTo.subject, from: entry.replyTo.from } : null,
      revision: item.item.changeKey,
    };
  }

  async drafts(signal?: AbortSignal): Promise<{ drafts: Draft[] }> {
    const entries = await this.readDrafts();
    if (entries.length === 0) return { drafts: [] };
    const client = await this.client();
    const out: Draft[] = [];
    for (const entry of entries) {
      const draft = await this.view(client, entry, signal);
      if (draft) out.push(draft);
    }
    return { drafts: out.sort((a, b) => b.createdAt - a.createdAt) };
  }

  /** A waiting draft. With `threadId`, only one prepared in that thread. */
  private async entry(id: string, threadId?: string): Promise<DraftEntry | undefined> {
    const entry = (await this.readDrafts()).find((d) => d.id === id);
    if (entry && threadId !== undefined && entry.threadId !== threadId) return undefined;
    return entry;
  }

  async draft(id: string, signal?: AbortSignal, threadId?: string): Promise<Draft | null> {
    const entry = await this.entry(id, threadId);
    if (!entry) return null;
    return this.view(await this.client(), entry, signal);
  }

  async saveDraft(input: DraftInput, signal?: AbortSignal): Promise<Draft> {
    const client = await this.client();
    const entries = await this.readDrafts();
    const previous = input.replaces ? entries.find((d) => d.id === input.replaces) : undefined;
    if (input.replaces && !previous) throw new UserError(`There is no draft ${input.replaces} any more; save a new one instead.`);
    if (previous && input.source === "agent" && (previous.source !== "agent" || previous.threadId !== (input.threadId ?? null))) {
      throw new UserError(`Draft ${previous.id} was not prepared in this thread; save a new draft instead.`);
    }
    if (!previous && entries.length >= MAX_DRAFTS) throw new UserError("Too many drafts are waiting. Send or discard some in Mail → Settings in the bb sidebar first.");

    // A revision keeps what it does not change: the recipients and subject of the version it replaces.
    // Not across kinds: a reply turned into reply-all gets the recipients Exchange picks for it.
    const kept = previous && previous.kind === input.kind && (input.to === undefined || input.cc === undefined || input.subject === undefined) ? await this.recipientsOf(client, previous, signal) : null;
    const to = input.to?.map(parseRecipient) ?? kept?.to;
    const cc = input.cc?.map(parseRecipient) ?? kept?.cc;
    const subject = input.subject ?? kept?.subject;
    let replyTo: DraftEntry["replyTo"] = null;
    let reference: ItemRef | undefined;
    if (input.kind === "new") {
      if (!to?.length) throw new UserError("A new message needs at least one recipient in to");
      if (!subject?.trim()) throw new UserError("A new message needs a subject");
    } else {
      if (input.kind === "forward" && !to?.length) throw new UserError("A forward needs at least one recipient in to");
      const replyRef = input.replyTo ?? previous?.replyTo?.ref;
      if (!replyRef) {
        throw new UserError(input.kind === "forward" ? "A forward needs the [ref] of the message to forward" : "A reply needs reply_to: the [ref] of the message being answered");
      }
      const itemId = previous?.replyTo && previous.replyTo.ref === replyRef ? previous.replyTo.itemId : await this.itemIdOf(replyRef);
      const original = await client.get({ id: itemId }, signal);
      reference = original.item;
      replyTo = { ref: replyRef, itemId, subject: original.subject, from: original.from ? toAddress(original.from) : null };
    }

    const created = await client.createDraft(
      { kind: input.kind, reference, to, cc, subject: subject?.trim() || undefined, body: input.body },
      signal,
    );
    const entry: DraftEntry = {
      id: previous?.id ?? `d_${randomBytes(6).toString("hex")}`,
      itemId: created.id,
      kind: input.kind,
      source: previous?.source ?? input.source,
      threadId: previous?.threadId ?? input.threadId ?? null,
      createdAt: this.now(),
      text: input.body,
      replyTo,
    };
    await this.writeDrafts(async () => {
      const current = (await this.readDrafts()).filter((d) => d.id !== entry.id);
      await writeJson(this.draftsFile(), [...current, entry]);
    });
    // The new version is saved before the old one goes, so a failure never loses the draft.
    if (previous) await client.delete({ id: previous.itemId }, signal).catch(() => undefined);
    const draft = await this.view(client, entry, signal);
    if (!draft) throw new EwsError("ErrorItemNotFound", "Exchange lost the draft right after saving it");
    return draft;
  }

  /** Who an earlier version of a draft goes to, and its subject; null when Exchange no longer has it. */
  private async recipientsOf(client: EwsClient, entry: DraftEntry, signal?: AbortSignal): Promise<{ to: Address[]; cc: Address[]; subject: string } | null> {
    try {
      const item = await client.get({ id: entry.itemId }, signal);
      return { to: item.to, cc: item.cc, subject: item.subject };
    } catch (error) {
      if (error instanceof EwsError && error.code === "ErrorItemNotFound") return null;
      throw error;
    }
  }

  async discardDraft(id: string, signal?: AbortSignal, threadId?: string): Promise<{ ok: boolean }> {
    const entry = await this.entry(id, threadId);
    if (!entry) return { ok: false };
    const client = await this.client();
    await client.delete({ id: entry.itemId }, signal).catch((error) => {
      if (!(error instanceof EwsError && error.code === "ErrorItemNotFound")) throw error;
    });
    await this.writeDrafts(async () => writeJson(this.draftsFile(), (await this.readDrafts()).filter((d) => d.id !== id)));
    return { ok: true };
  }

  /**
   * Sends a draft only at the version the person saw, and only after they
   * confirm it in a system window on this machine:
   *   1. the change key the panel showed must still be the draft's change key —
   *      an agent revising the draft or an edit in Outlook changes it;
   *   2. the window shows that exact version as Exchange holds it: recipients
   *      including Bcc, subject, attachments, format and the start of the text;
   *   3. SendItem names the same change key, so a draft changed while the
   *      window was open is refused by Exchange instead of sent.
   * Nothing here trusts the caller: bb cannot tell the panel from an agent.
   */
  async send(id: string, revision: string, signal?: AbortSignal, options: { threadId?: string; lang?: Lang } = {}): Promise<SendResult> {
    const entry = await this.entry(id, options.threadId);
    if (!entry) return { status: "gone", message: "This draft is no longer waiting: it was sent, discarded or replaced." };
    const connection = await this.readConnection();
    const client = await this.client();
    const gone = async (): Promise<SendResult> => {
      await this.writeDrafts(async () => writeJson(this.draftsFile(), (await this.readDrafts()).filter((d) => d.id !== id)));
      return { status: "gone", message: "The draft is not in Drafts any more: it was sent or deleted in Outlook." };
    };
    const changed: SendResult = { status: "changed", message: "The draft changed after you opened it. Review the new version before sending." };
    let item: ParsedMessage;
    try {
      item = await client.get({ id: entry.itemId }, signal);
    } catch (error) {
      if (error instanceof EwsError && error.code === "ErrorItemNotFound") return gone();
      throw error;
    }
    if (item.item.changeKey !== revision) return changed;

    const outcome = await this.confirmer.confirm(this.summaryOf(entry, item, connection?.auth === "password" ? connection.user : null), signal, options.lang ?? "en");
    if (!outcome.ok) return { status: "cancelled", reason: outcome.reason, message: outcome.message };

    try {
      const current = await client.currentId({ id: entry.itemId }, signal);
      if (current.changeKey !== revision) return changed;
      await client.send({ id: entry.itemId, changeKey: revision }, signal);
    } catch (error) {
      if (error instanceof EwsError && error.code === "ErrorItemNotFound") return gone();
      if (error instanceof EwsError && /Stale|Conflict|ChangeKey/i.test(error.code)) return changed;
      throw error;
    }
    await this.writeDrafts(async () => writeJson(this.draftsFile(), (await this.readDrafts()).filter((d) => d.id !== id)));
    return { status: "sent", at: this.now() };
  }

  private summaryOf(entry: DraftEntry, item: ParsedMessage, mailbox: string | null): SendSummary {
    // The same split the panel shows: the text written for the draft, then the quoted original.
    const quote = item.body.startsWith(entry.text) ? item.body.slice(entry.text.length).trim() : "";
    return {
      kind: entry.kind,
      mailbox,
      subject: item.subject,
      to: item.to.map(toAddress),
      cc: item.cc.map(toAddress),
      bcc: item.bcc.map(toAddress),
      attachments: item.attachments.map(plainAttachment),
      bodyFormat: item.bodyFormat,
      text: quote ? entry.text : item.body,
      quotedChars: quote.length,
    };
  }

  // ------------------------------------------------------------------ meetings

  private meetingsFile = () => join(this.dataDir, "meetings.json");
  private readMeetings = async () => (await readJson<ProposalEntry[]>(this.meetingsFile())) ?? [];
  private dropMeeting = (id: string) => this.writeMeetings(async () => writeJson(this.meetingsFile(), (await this.readMeetings()).filter((p) => p.id !== id)));

  private async eventItemId(eventId: string): Promise<string> {
    const itemId = (await this.refMap()).get(eventId.trim());
    if (!itemId) throw new UserError(`Unknown event "${eventId}". Read the calendar first (calendar_events) and use an [id] from it.`);
    return itemId;
  }

  /** An event read whole, for the panel's edit form. */
  async meetingDetails(eventId: string, signal?: AbortSignal): Promise<MeetingDetails> {
    const item = await (await this.client()).calendarItem({ id: await this.eventItemId(eventId) }, signal);
    const event = toEvent(item);
    return {
      eventId,
      subject: item.subject,
      start: event.start,
      end: event.end,
      location: item.location,
      required: item.required,
      optional: item.optional,
      rooms: item.rooms,
      body: item.body,
      organizer: item.organizer,
      isOrganizer: item.myResponse.toLowerCase() === "organizer",
      myResponse: event.myResponse,
      kind: event.kind,
      isMeeting: item.isMeeting,
      cancelled: item.cancelled,
      private: event.private,
    };
  }

  async meeting(id: string, threadId?: string): Promise<MeetingProposal | null> {
    const entry = (await this.readMeetings()).find((p) => p.id === id);
    if (!entry || (threadId !== undefined && entry.threadId !== threadId)) return null;
    return proposalView(entry);
  }

  async discardMeeting(id: string, threadId?: string): Promise<{ ok: boolean }> {
    if (!(await this.meeting(id, threadId))) return { ok: false };
    await this.dropMeeting(id);
    return { ok: true };
  }

  /**
   * Works out a meeting change and keeps it as a proposal. Nothing is written
   * to Exchange: the item is only read, to know what it is now and at which
   * change key.
   */
  async proposeMeeting(input: MeetingInput, source: "agent" | "person", threadId: string | null, signal?: AbortSignal, timeZone?: string): Promise<MeetingProposal> {
    const zone = this.zone(timeZone);
    const entries = await this.readMeetings();
    const previous = input.replaces ? entries.find((p) => p.id === input.replaces) : undefined;
    if (input.replaces && !previous) throw new UserError(`There is no proposal ${input.replaces} any more; make a new one instead.`);
    if (previous && source === "agent" && (previous.source !== "agent" || previous.threadId !== threadId)) {
      throw new UserError(`Proposal ${previous.id} was not made in this thread; make a new one instead.`);
    }
    if (!previous && entries.length >= MAX_PROPOSALS) throw new UserError("Too many meeting proposals are waiting. Confirm or discard some first.");
    const client = await this.client();
    const id = previous?.id ?? `p_${randomBytes(6).toString("hex")}`;
    const people = (list: readonly string[] | undefined) => uniqueAddresses((list ?? []).map(parseRecipient).map(toAddress));
    const text = (value: string | undefined) => (value === undefined ? undefined : value.replace(/\r\n?/g, "\n").trim());

    let entry: Omit<ProposalEntry, "revision" | "createdAt">;
    if (input.action === "create") {
      const start = parseWhen(input.start, zone);
      const end = parseWhen(input.end, zone);
      checkMeetingTime(start, end, this.now());
      const after: MeetingFields = {
        subject: input.subject.trim(),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        location: text(input.location) || null,
        required: people(input.required),
        optional: people(input.optional),
        rooms: people(input.rooms),
      };
      if (!after.subject) throw new UserError("A meeting needs a subject.");
      entry = {
        id, action: "create", source, threadId, scope: "single", eventId: null, target: null, before: null, after,
        body: text(input.body) || null, organizer: null, response: null, note: null, notify: everyone(after), removed: [], changes: null,
      };
    } else {
      const itemId = await this.eventItemId(input.event);
      const occurrence = await client.calendarItem({ id: itemId }, signal);
      const event = toEvent(occurrence);
      // Agents get only the time of a private event; they do not get to change it either.
      if (event.private && source === "agent") throw new UserError("This event is private: the user changes it in the Mail panel or in Outlook.");
      const recurring = event.kind !== "single";
      if (recurring && !input.scope) {
        throw new UserError(`Event ${input.event} is one meeting of a recurring series: set scope to "occurrence" for this one only or "series" for all of them.`);
      }
      const scope: MeetingScope = recurring ? input.scope! : "single";
      const series = scope === "series" ? await client.recurringMaster({ id: itemId }, signal) : null;
      const item = series ?? occurrence;
      if (!item.item.changeKey) throw new EwsError("BadResponse", "Exchange did not return the meeting's version");
      const isOrganizer = item.myResponse.toLowerCase() === "organizer";
      const before: MeetingFields = {
        subject: item.subject,
        // An occurrence's own times, also for the series: the person sees the meeting they picked.
        start: event.start,
        end: event.end,
        location: item.location,
        required: item.required,
        optional: item.optional,
        rooms: item.rooms,
      };
      const base = { id, source, threadId, scope, eventId: input.event, target: { itemId: item.item.id, changeKey: item.item.changeKey }, before, organizer: item.organizer };

      if (input.action === "respond") {
        if (isOrganizer || !item.isMeeting) throw new UserError("The user organizes this one: there is no invitation to answer. Propose a change or a cancellation instead.");
        if (item.cancelled) throw new UserError("This meeting was cancelled by its organizer: there is nothing to answer.");
        entry = {
          ...base, action: "respond", after: null, body: null, response: input.response, note: text(input.note) || null,
          notify: [item.organizer ?? { name: "The organizer", email: "" }], removed: [], changes: null,
        };
      } else if (!isOrganizer) {
        throw new UserError("Someone else organizes this meeting, so only they can change or cancel it. Answer the invitation instead (calendar_propose_response).");
      } else if (input.action === "cancel") {
        if (item.cancelled) throw new UserError("This meeting is already cancelled.");
        entry = { ...base, action: "cancel", after: null, body: null, response: null, note: text(input.note) || null, notify: everyone(before), removed: [], changes: null };
      } else {
        if (item.cancelled) throw new UserError("This meeting is cancelled; propose a new one instead.");
        const oldStart = Date.parse(event.start);
        const oldEnd = Date.parse(event.end);
        const start = input.start ? parseWhen(input.start, zone) : oldStart;
        const end = input.end ? parseWhen(input.end, zone) : input.start ? start + (oldEnd - oldStart) : oldEnd;
        const timeChanged = start !== oldStart || end !== oldEnd;
        if (timeChanged && item.allDay) throw new UserError("This is an all-day event: change its days in Outlook.");
        if (timeChanged) checkMeetingTime(start, end, this.now());
        if (timeChanged && scope === "series" && !sameLocalDay(oldStart, start, zone)) {
          throw new UserError("Moving a whole series to another day changes how it repeats: do that in Outlook. You can move this one occurrence, or change the series' time on the same day.");
        }
        let required = input.required ? people(input.required) : before.required;
        let optional = input.optional ? people(input.optional) : before.optional;
        let rooms = input.rooms ? people(input.rooms) : before.rooms;
        if (input.add?.length) required = uniqueAddresses([...required, ...missingFrom(people(input.add), [...required, ...optional, ...rooms])]);
        if (input.remove?.length) {
          const gone = people(input.remove);
          const unknown = missingFrom(gone, everyone(before));
          if (unknown.length) throw new UserError(`${unknown.map((a) => a.email).join(", ")} ${unknown.length === 1 ? "is" : "are"} not on this meeting.`);
          required = missingFrom(required, gone);
          optional = missingFrom(optional, gone);
          rooms = missingFrom(rooms, gone);
        }
        const location = input.location === undefined ? before.location : text(input.location) || null;
        const subject = input.subject === undefined ? before.subject : input.subject.trim();
        const body = input.body === undefined ? null : text(input.body) ?? "";
        const after: MeetingFields = { subject, start: new Date(start).toISOString(), end: new Date(end).toISOString(), location, required, optional, rooms };

        const changes: { -readonly [K in keyof MeetingChanges]: MeetingChanges[K] } = {};
        if (subject !== before.subject) changes.subject = subject;
        if (location !== before.location) changes.location = location;
        if (body !== null && body !== item.body.trim()) changes.body = body;
        if (timeChanged) {
          // A series moves by the same amount from its own first meeting, keeping each meeting's new length.
          const from = series ? Date.parse(series.start) + (start - oldStart) : start;
          changes.start = new Date(from).toISOString();
          changes.end = new Date(from + (end - start)).toISOString();
        }
        const lists = [["required", required, before.required], ["optional", optional, before.optional], ["rooms", rooms, before.rooms]] as const;
        for (const [name, now, was] of lists) {
          if (sameList(now, was)) continue;
          // Exchange may list a colleague by an internal (X.500) address only, which cannot be written back.
          const unwritable = now.find((a) => !a.email);
          if (unwritable) throw new UserError(`${unwritable.name ?? "Someone"} is on this meeting without an email address bb can write back: change the attendees in Outlook.`);
          changes[name] = now;
        }
        if (Object.keys(changes).length === 0) throw new UserError("Nothing changes: the meeting already looks like that.");
        const removed = missingFrom(everyone(before), everyone(after));
        entry = { ...base, action: "update", after, body: changes.body === undefined ? null : body, response: null, note: null, notify: everyone(after), removed, changes };
      }
    }

    const saved: ProposalEntry = { ...entry, createdAt: this.now(), revision: revisionOf(entry) };
    await this.writeMeetings(async () => {
      const current = (await this.readMeetings()).filter((p) => p.id !== saved.id);
      await writeJson(this.meetingsFile(), [...current, saved]);
    });
    return proposalView(saved);
  }

  /**
   * Writes a proposal to Exchange only at the revision the person saw, and only
   * after they confirm it in a system window on this machine:
   *   1. the revision named must still be the proposal's — an agent replacing
   *      it makes a new one;
   *   2. the meeting must still be at the change key read when proposing — an
   *      edit in Outlook or an update from the organizer changes it;
   *   3. the window shows what changes and everyone who gets mail;
   *   4. the write names that change key, so Exchange refuses a meeting that
   *      changed while the window was open.
   */
  async confirmMeeting(id: string, revision: string, signal?: AbortSignal, options: { threadId?: string; lang?: Lang; timeZone?: string } = {}): Promise<MeetingResult> {
    // One confirmation per proposal at a time: two cards confirming the same new meeting must not create it twice.
    if (this.confirmingMeetings.has(id)) return { status: "cancelled", reason: "busy", message: NOT_CONFIRMED.busy };
    this.confirmingMeetings.add(id);
    try {
      return await this.confirmMeetingOnce(id, revision, signal, options);
    } finally {
      this.confirmingMeetings.delete(id);
    }
  }

  private async confirmMeetingOnce(id: string, revision: string, signal: AbortSignal | undefined, options: { threadId?: string; lang?: Lang; timeZone?: string }): Promise<MeetingResult> {
    const entry = (await this.readMeetings()).find((p) => p.id === id);
    if (!entry || (options.threadId !== undefined && entry.threadId !== options.threadId)) {
      return { status: "gone", message: "This proposal is no longer waiting: it was confirmed, discarded or replaced." };
    }
    if (entry.revision !== revision) return { status: "changed", message: "The proposal changed after you opened it. Review the new version before confirming." };
    const connection = await this.readConnection();
    const client = await this.client();
    const gone = async (): Promise<MeetingResult> => {
      await this.dropMeeting(id);
      return { status: "gone", message: "The meeting is not in the calendar any more: it was deleted or cancelled in Outlook." };
    };
    const moved: MeetingResult = { status: "changed", message: "The meeting changed in Outlook after this was proposed. Nothing was changed: make the proposal again from the meeting as it is now." };
    const current = async () => {
      if (!entry.target) return true;
      const now = await client.currentId({ id: entry.target.itemId }, signal);
      return now.changeKey === entry.target.changeKey;
    };
    try {
      if (!(await current())) return moved;
    } catch (error) {
      if (error instanceof EwsError && error.code === "ErrorItemNotFound") return gone();
      throw error;
    }

    const outcome = await this.confirmer.confirm(this.meetingSummary(entry, connection?.auth === "password" ? connection.user : null, options.lang ?? "en", this.zone(options.timeZone)), signal, options.lang ?? "en");
    if (!outcome.ok) return { status: "cancelled", reason: outcome.reason, message: NOT_CONFIRMED[outcome.reason] };

    // The proposal is taken off the list before anything is written, and only if it is still the version the window showed:
    // an agent may have replaced it while the window was open.
    const claimed = await this.writeMeetings(async () => {
      const all = await this.readMeetings();
      const now = all.find((p) => p.id === id);
      if (!now || now.revision !== revision) return false;
      await writeJson(this.meetingsFile(), all.filter((p) => p.id !== id));
      return true;
    });
    if (!claimed) return { status: "changed", message: "The proposal changed while the window was open. Nothing was changed: review the new version." };
    const putBack = () =>
      this.writeMeetings(async () => {
        const all = await this.readMeetings();
        if (!all.some((p) => p.id === id)) await writeJson(this.meetingsFile(), [...all, entry]);
      });

    try {
      if (!(await current())) {
        await putBack();
        return moved;
      }
      const ref = entry.target ? { id: entry.target.itemId, changeKey: entry.target.changeKey } : null;
      if (entry.action === "create") {
        await client.createMeeting({ ...entry.after!, body: entry.body }, signal);
      } else if (entry.action === "update") {
        const notify = entry.notify.length + entry.removed.length > 0;
        await client.updateMeeting(ref!, entry.changes!, { notify }, signal);
      } else if (entry.action === "cancel") {
        if (entry.notify.length) await client.cancelMeeting(ref!, entry.note, signal);
        else await client.deleteAppointment(ref!, signal);
      } else {
        await client.respondToMeeting(ref!, entry.response!, entry.note, signal);
      }
    } catch (error) {
      if (error instanceof EwsError && error.code === "ErrorItemNotFound") return gone();
      // Not written: the proposal waits again, for another try or a new one.
      await putBack();
      if (error instanceof EwsError && /Stale|Conflict|ChangeKey/i.test(error.code)) return moved;
      throw error;
    }
    return { status: "done", at: this.now() };
  }

  private meetingSummary(entry: ProposalEntry, mailbox: string | null, lang: Lang, zone: Offset): MeetingSummary {
    const fields = (entry.after ?? entry.before)!;
    const span = (f: MeetingFields) => spanText(Date.parse(f.start), Date.parse(f.end), zone, lang);
    const before: { subject?: string; when?: string; location?: string | null } = {};
    if (entry.action === "update" && entry.before && entry.after) {
      if (entry.after.subject !== entry.before.subject) before.subject = entry.before.subject;
      if (entry.after.start !== entry.before.start || entry.after.end !== entry.before.end) before.when = span(entry.before);
      if (entry.after.location !== entry.before.location) before.location = entry.before.location;
    }
    const lists: { required?: MailAddress[]; optional?: MailAddress[]; rooms?: MailAddress[] } = {};
    if (entry.action === "update" && entry.before && entry.after) {
      for (const name of ["required", "optional", "rooms"] as const) if (!sameList(entry.after[name], entry.before[name])) lists[name] = entry.after[name];
    }
    return {
      meeting: entry.action,
      mailbox,
      lists,
      scope: entry.scope,
      subject: fields.subject,
      when: span(fields),
      location: fields.location,
      before,
      body: entry.body,
      added: entry.action === "update" ? missingFrom(everyone(entry.after), everyone(entry.before)) : [],
      removed: entry.removed,
      notify: entry.notify,
      response: entry.response,
      note: entry.note,
    };
  }

  /** Times everyone is free: the user's own calendar and the others' free/busy from Exchange. */
  private async findTime(input: Extract<ToolInput, { tool: "findTime" }>, zone: Offset, signal?: AbortSignal): Promise<string> {
    const range = rangeOf(input, this.now(), zone, { fromNow: true, maxDays: FREE_TIME_MAX_DAYS });
    const options = {
      dayStart: minutesOf(input.dayStart ?? "09:00"),
      dayEnd: minutesOf(input.dayEnd ?? "18:00"),
      minMinutes: input.minutes ?? 30,
      weekends: input.weekends ?? false,
      offset: zone,
    };
    if (options.dayEnd <= options.dayStart) throw new UserError("day_end must come after day_start.");
    const emails = uniqueAddresses(input.attendees.map(parseRecipient).map(toAddress)).map((a) => a.email);
    const client = await this.client();
    const start = new Date(range.start).toISOString();
    const end = new Date(range.end).toISOString();
    const [own, others] = await Promise.all([this.readCalendar(range.start, range.end, signal), client.availability({ emails, start, end }, signal)]);
    const busy = own.events.filter(blocksTime).map((event) => ({ start: Date.parse(event.start), end: Date.parse(event.end) }));
    const people = emails.map((email, n) => {
      const answer = others[n]!;
      if (!answer.ok) return { email, known: false, why: answer.message };
      for (const block of answer.busy) if (block.type !== "Free" && block.type !== "NoData") busy.push({ start: Date.parse(block.start), end: Date.parse(block.end) });
      return { email, known: true, why: null };
    });
    return formatCommonTime(freeStretches(busy, range, options), range, options, people, own.more);
  }

  /** Other people's free/busy, each on their own and the times all of them are free; the user's calendar is left out. */
  private async availability(input: Extract<ToolInput, { tool: "availability" }>, zone: Offset, signal?: AbortSignal): Promise<string> {
    const range = rangeOf(input, this.now(), zone, { maxDays: FREE_TIME_MAX_DAYS });
    const options = {
      dayStart: minutesOf(input.dayStart ?? "09:00"),
      dayEnd: minutesOf(input.dayEnd ?? "18:00"),
      minMinutes: input.minutes ?? 30,
      weekends: input.weekends ?? false,
      offset: zone,
    };
    if (options.dayEnd <= options.dayStart) throw new UserError("day_end must come after day_start.");
    const emails = uniqueAddresses(input.people.map(parseRecipient).map(toAddress)).map((a) => a.email);
    const client = await this.client();
    const answers = await client.availability({ emails, start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() }, signal);
    const people: PersonBusy[] = emails.map((email, n) => {
      const answer = answers[n]!;
      if (!answer.ok) return { email, known: false, why: answer.message, busy: [] };
      const busy = answer.busy.flatMap((block) => {
        const kind = busyKind(block.type);
        const start = Date.parse(block.start);
        const end = Date.parse(block.end);
        return kind && end > start ? [{ start, end, kind }] : [];
      });
      return { email, known: true, why: null, busy };
    });
    const together = people.flatMap((person) => person.busy);
    return formatAvailability(freeStretches(together, range, options), range, options, people);
  }

  /** Another person's calendar, when they shared it with the user; read only. */
  private async otherEvents(input: Extract<ToolInput, { tool: "otherEvents" }>, zone: Offset, signal?: AbortSignal): Promise<string> {
    const { email } = parseRecipient(input.mailbox);
    const range = rangeOf(input, this.now(), zone, { maxDays: CALENDAR_MAX_DAYS });
    let read: CalendarOutput;
    try {
      read = await this.readCalendar(range.start, range.end, signal, email);
    } catch (error) {
      if (error instanceof EwsError && NOT_SHARED.has(error.code)) {
        throw new UserError(
          `The calendar of ${email} is not shared with the user, so only their free/busy is visible: use calendar_availability for when they are busy. ` +
            "To see their meetings, they can share their calendar in Outlook.",
        );
      }
      if (error instanceof EwsError && NO_MAILBOX.has(error.code)) {
        throw new UserError(`Exchange has no mailbox for ${email}. Check the address with mail_find_person.`);
      }
      throw error;
    }
    return formatEvents(read.events, range, read.more, zone, { kind: "other", email });
  }

  // --------------------------------------------------------------- agent tools

  /** `timeZone`: the zone agents read and write times in (the plugin's setting); omitted, this machine's. */
  async tool(input: ToolInput, signal?: AbortSignal, timeZone?: string): Promise<ToolOutput> {
    const zone = this.zone(timeZone);
    try {
      switch (input.tool) {
        case "list": {
          const folder = input.folder ?? "inbox";
          const result = await this.list({ folder, unreadOnly: input.unreadOnly, limit: input.limit ?? 20, offset: input.offset }, signal);
          const title = `${FOLDER_TITLE[folder]}${input.unreadOnly ? ", unread only" : ""}${result.unread !== null ? ` (${result.unread} unread in total)` : ""}`;
          return { text: formatList(title, result.messages, result.more, zone), isError: false, draftId: null };
        }
        case "search": {
          const limit = input.limit ?? 20;
          const folders: Folder[] = input.folder === "inbox" ? ["inbox"] : input.folder === "sent" ? ["sent"] : ["inbox", "sent"];
          const results = await Promise.all(folders.map((folder) => this.list({ folder, query: input.query, limit }, signal)));
          const messages = results
            .flatMap((r) => r.messages)
            .sort((a, b) => (b.received ?? "").localeCompare(a.received ?? ""))
            .slice(0, limit);
          const more = results.some((r) => r.more) || results.reduce((n, r) => n + r.messages.length, 0) > limit;
          const where = folders.map((f) => FOLDER_TITLE[f]).join(" and ");
          return { text: formatList(`Search "${input.query}" in ${where}`, messages, more, zone), isError: false, draftId: null };
        }
        case "read": {
          const message = await this.read(input.ref, false, signal);
          return { text: formatMessage(message, input.maxChars ?? 20_000, zone), isError: false, draftId: null };
        }
        case "attachment": {
          const file = await this.fileAttachment(input.ref, input.index, signal);
          const text = await attachmentText(file.name, file.contentType, file.content, { signal });
          return { text: formatAttachment(input.ref, input.index, file.name, text, input.maxChars ?? 30_000), isError: false, draftId: null };
        }
        case "conversation": {
          const { messages } = await this.conversation(input.ref, signal);
          return { text: formatConversation(input.ref, messages, zone), isError: false, draftId: null };
        }
        case "people": {
          const found = await this.findPeople(input.query, signal);
          return { text: formatPeople(input.query, found), isError: false, draftId: null, people: found.people, more: found.more };
        }
        case "events": {
          const range = rangeOf(input, this.now(), zone, { maxDays: CALENDAR_MAX_DAYS });
          const { events, more } = await this.readCalendar(range.start, range.end, signal);
          return { text: formatEvents(events, range, more, zone), isError: false, draftId: null };
        }
        case "freeTime": {
          const range = rangeOf(input, this.now(), zone, { fromNow: true, maxDays: FREE_TIME_MAX_DAYS });
          const options = {
            dayStart: minutesOf(input.dayStart ?? "09:00"),
            dayEnd: minutesOf(input.dayEnd ?? "18:00"),
            minMinutes: input.minMinutes ?? 30,
            weekends: input.weekends ?? false,
            offset: zone,
          };
          if (options.dayEnd <= options.dayStart) throw new UserError("day_end must come after day_start.");
          const { events, more } = await this.readCalendar(range.start, range.end, signal);
          return { text: formatFreeTime(freeSlots(events, range, options), range, options, more), isError: false, draftId: null };
        }
        case "findTime":
          return { text: await this.findTime(input, zone, signal), isError: false, draftId: null };
        case "availability":
          return { text: await this.availability(input, zone, signal), isError: false, draftId: null };
        case "otherEvents":
          return { text: await this.otherEvents(input, zone, signal), isError: false, draftId: null };
        case "meeting": {
          const proposal = await this.proposeMeeting(input.proposal, "agent", input.threadId, signal, timeZone);
          return { text: formatProposal(proposal, zone, Boolean(input.proposal.replaces)), isError: false, draftId: null, meetingId: proposal.id };
        }
        case "draft": {
          let kind: Draft["kind"] = input.forward ? "forward" : input.replyTo ? (input.replyAll ? "replyAll" : "reply") : "new";
          if (!input.replyTo && !input.forward && input.replaces) {
            // A revision of a reply stays a reply to the same message.
            const previous = (await this.readDrafts()).find((d) => d.id === input.replaces);
            if (previous && previous.kind !== "new") kind = input.replyAll === undefined || previous.kind === "forward" ? previous.kind : input.replyAll ? "replyAll" : "reply";
          }
          const draft = await this.saveDraft(
            {
              kind,
              replyTo: input.forward ?? input.replyTo,
              to: input.to,
              cc: input.cc,
              subject: input.subject,
              body: input.body,
              replaces: input.replaces,
              threadId: input.threadId,
              source: "agent",
            },
            signal,
          );
          return { text: formatDraft(draft, Boolean(input.replaces)), isError: false, draftId: draft.id };
        }
      }
    } catch (error) {
      return { text: describe(error), isError: true, draftId: null };
    }
  }
}

/** What Exchange answers for a calendar its owner did not share with the user. */
const NOT_SHARED = new Set(["ErrorAccessDenied", "ErrorFolderNotFound", "ErrorItemNotFound", "ErrorNoPublicFolderReplicaAvailable", "ErrorDelegateNoUser"]);
/** What it answers for an address without a mailbox. */
const NO_MAILBOX = new Set(["ErrorNonExistentMailbox", "ErrorMailRecipientNotFound", "ErrorInvalidSmtpAddress", "ErrorMissingEmailAddress"]);

/** Why nothing changed, for agents and logs; the panel says it in its own words. */
const NOT_CONFIRMED: Record<"cancelled" | "timeout" | "unavailable" | "busy", string> = {
  cancelled: "You did not confirm in the system window. Nothing changed in the calendar and no mail went out.",
  timeout: "Nobody answered the system window in time. Nothing changed in the calendar.",
  unavailable: "bb could not show the confirmation window on this machine, so nothing changed. Make the change in Outlook instead.",
  busy: "Another confirmation is waiting in a system window. Answer it first.",
};

/** A meeting ends after it starts, lasts at most two weeks, and has not ended yet. */
function checkMeetingTime(start: number, end: number, now: number): void {
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new UserError("The meeting must end after it starts.");
  if (end - start > MEETING_MAX_MS) throw new UserError("A meeting can last two weeks at most.");
  if (end <= now) throw new UserError("That time is already over: pick a time in the future.");
}

/** A picture type for a data: URL, read from the bytes, not the declared type: raster formats only, no SVG. */
function imageType(content: Buffer): string | null {
  const head = content.subarray(0, 12);
  if (head[0] === 0x89 && head.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.toString("latin1", 0, 3) === "GIF") return "image/gif";
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (head[0] === 0x42 && head[1] === 0x4d) return "image/bmp";
  return null;
}
