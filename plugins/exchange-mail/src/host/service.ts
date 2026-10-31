// Mail on the person's machine: the connection, short message refs, drafts
// prepared through bb, and the agent tools' answers.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  AuthMode,
  ConnectionStatus,
  Lang,
  Draft,
  DraftInput,
  Folder,
  ListInput,
  ListOutput,
  MailAddress,
  MailMessage,
  MessageSummary,
  SendResult,
  ToolInput,
} from "../../contract.js";
import { oneAtATime, systemConfirmer, type SendConfirmer, type SendSummary } from "./confirm.js";
import { curlTransport, TransportError, type HttpAuth, type Transport } from "./curl.js";
import { AuthError, EwsClient, EwsError, normalizeEwsUrl } from "./ews/client.js";
import type { ParsedMessage, ParsedSummary } from "./ews/parse.js";
import type { Address, FolderName, ItemRef } from "./ews/soap.js";
import { readJson, removeFile, serial, writeJson } from "./files.js";
import { formatDraft, formatList, formatMessage } from "./format.js";
import { openSecretStore, type SecretStore } from "./secret-store.js";
import { accountName, SignInGate, SignInPaused, type Refusal, type RefusalStore } from "./signin.js";

const EWS_FOLDER: Record<Folder, FolderName> = { inbox: "inbox", sent: "sentitems", drafts: "drafts", deleted: "deleteditems" };
const FOLDER_TITLE: Record<Folder, string> = { inbox: "Inbox", sent: "Sent Items", drafts: "Drafts", deleted: "Deleted Items" };
const PASSWORD = "password";
const MAX_REFS = 5000;
const MAX_DRAFTS = 100;

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

export class UserError extends Error {}

export interface MailServiceOptions {
  readonly dataDir: string;
  readonly transport?: Transport;
  readonly secrets?: SecretStore;
  readonly platform?: NodeJS.Platform;
  /** For tests: minutes east of UTC used in agent answers. */
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

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** "Name <email>" or "email". */
export function parseRecipient(input: string): Address {
  const text = input.trim();
  const angle = /^(.*)<([^<>]+)>$/.exec(text);
  const email = (angle ? angle[2]! : text).trim();
  const name = angle ? angle[1]!.trim().replace(/^"(.*)"$/, "$1").trim() : "";
  if (!ADDRESS.test(email)) throw new UserError(`"${input}" is not an email address`);
  return { name: name || null, email };
}

const toAddress = (a: Address): MailAddress => ({ name: a.name, email: a.email });

function describe(error: unknown): string {
  if (error instanceof UserError || error instanceof SignInPaused || error instanceof AuthError || error instanceof TransportError || error instanceof EwsError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

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
    try {
      return normalizeEwsUrl(input, { allowLocalHttp: this.allowLocalHttp });
    } catch (error) {
      throw new UserError(describe(error));
    }
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
      curlError = describe(error);
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
      if (!user) throw new UserError("Enter the login, for example DOMAIN\\name or name@company.com");
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
          throw new UserError(
            hadOne
              ? "The saved password was for the previous address or login, so bb removed it. Enter the password for this one."
              : "Enter the password",
          );
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
    this.gate.reset();
    await removeFile(this.connectionFile());
    await this.writeDrafts(() => removeFile(this.draftsFile()));
    await this.writeRefs(async () => {
      this.refs = new Map();
      await removeFile(this.refsFile());
    });
    return this.status();
  }

  private async client(options: { retry?: boolean } = {}): Promise<EwsClient> {
    const connection = await this.readConnection();
    if (!connection) throw new UserError("Mail is not connected on this machine yet. Connect it in Mail → Settings in the bb sidebar.");
    const url = this.normalizeUrl(connection.url);
    if (connection.auth === "negotiate") return new EwsClient({ url, auth: { kind: "negotiate" }, transport: this.transport });
    if (!connection.user || connection.passwordFor !== bindingOf(connection.url, connection.user)) {
      await this.secrets.delete(PASSWORD).catch(() => false);
      throw new UserError("The mail password is missing on this machine. Enter it again in Mail → Settings in the bb sidebar.");
    }
    const account = { login: accountName(connection.user), version: connection.passwordVersion ?? null, url, retry: options.retry === true };
    // Fail before reading the password; the gate checks again at the moment it would sign in.
    const paused = await this.gate.check(account);
    if (paused) throw new UserError(paused);
    const stored = await this.secrets.get(PASSWORD);
    if (!stored) throw new UserError("The mail password is missing on this machine. Enter it again in Mail → Settings in the bb sidebar.");
    const auth: HttpAuth = { kind: "ntlm", user: connection.user, password: Buffer.from(stored, "base64").toString("utf8") };
    return new EwsClient({ url, auth, transport: this.gate.transport(this.transport, account) });
  }

  async check(retry = false, signal?: AbortSignal): Promise<{ ok: boolean; message: string; unread: number | null }> {
    const connection = await this.readConnection();
    if (!connection) return { ok: false, message: "Mail is not connected yet.", unread: null };
    let result: { ok: boolean; message: string; unread: number | null };
    try {
      const counts = await (await this.client({ retry })).folderCounts("inbox", signal);
      result = { ok: true, message: `Connected. Inbox: ${counts.total} messages, ${counts.unread} unread.`, unread: counts.unread };
    } catch (error) {
      result = { ok: false, message: describe(error), unread: null };
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

  private async remember(itemId: string): Promise<string> {
    const map = await this.refMap();
    const ref = refFor(itemId);
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
      body: item.body,
      attachments: item.attachments,
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

  async read(ref: string, markRead: boolean, signal?: AbortSignal): Promise<MailMessage> {
    const client = await this.client();
    const id = await this.itemIdOf(ref);
    const item = await client.get({ id }, signal);
    if (markRead && !item.isRead) {
      await client.markRead({ id }, true, signal).catch(() => undefined);
      return this.message({ ...item, isRead: true });
    }
    return this.message(item);
  }

  // -------------------------------------------------------------------- drafts

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
      attachments: item.attachments,
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

    const to = input.to?.map(parseRecipient);
    const cc = input.cc?.map(parseRecipient);
    let replyTo: DraftEntry["replyTo"] = null;
    let reference: ItemRef | undefined;
    if (input.kind === "new") {
      if (!to?.length) throw new UserError("A new message needs at least one recipient in to");
      if (!input.subject?.trim()) throw new UserError("A new message needs a subject");
    } else {
      const replyRef = input.replyTo ?? previous?.replyTo?.ref;
      if (!replyRef) throw new UserError("A reply needs reply_to: the [ref] of the message being answered");
      const itemId = previous?.replyTo && previous.replyTo.ref === replyRef ? previous.replyTo.itemId : await this.itemIdOf(replyRef);
      const original = await client.get({ id: itemId }, signal);
      reference = original.item;
      replyTo = { ref: replyRef, itemId, subject: original.subject, from: original.from ? toAddress(original.from) : null };
    }

    const created = await client.createDraft(
      { kind: input.kind, reference, to, cc, subject: input.subject?.trim() || undefined, body: input.body },
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
      attachments: item.attachments,
      bodyFormat: item.bodyFormat,
      text: quote ? entry.text : item.body,
      quotedChars: quote.length,
    };
  }

  // --------------------------------------------------------------- agent tools

  async tool(input: ToolInput, signal?: AbortSignal): Promise<{ text: string; isError: boolean; draftId: string | null }> {
    try {
      switch (input.tool) {
        case "list": {
          const folder = input.folder ?? "inbox";
          const result = await this.list({ folder, unreadOnly: input.unreadOnly, limit: input.limit ?? 20, offset: input.offset }, signal);
          const title = `${FOLDER_TITLE[folder]}${input.unreadOnly ? ", unread only" : ""}${result.unread !== null ? ` (${result.unread} unread in total)` : ""}`;
          return { text: formatList(title, result.messages, result.more, this.offset), isError: false, draftId: null };
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
          return { text: formatList(`Search "${input.query}" in ${where}`, messages, more, this.offset), isError: false, draftId: null };
        }
        case "read": {
          const message = await this.read(input.ref, false, signal);
          return { text: formatMessage(message, input.maxChars ?? 20_000, this.offset), isError: false, draftId: null };
        }
        case "draft": {
          let kind: Draft["kind"] = input.replyTo ? (input.replyAll ? "replyAll" : "reply") : "new";
          if (!input.replyTo && input.replaces) {
            // A revision of a reply stays a reply to the same message.
            const previous = (await this.readDrafts()).find((d) => d.id === input.replaces);
            if (previous && previous.kind !== "new") kind = input.replyAll === undefined ? previous.kind : input.replyAll ? "replyAll" : "reply";
          }
          const draft = await this.saveDraft(
            {
              kind,
              replyTo: input.replyTo,
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
