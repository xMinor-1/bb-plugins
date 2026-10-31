// Mail on the person's machine: the connection, short message refs, drafts
// prepared through bb, and the agent tools' answers.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  AuthMode,
  ConnectionStatus,
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
import { curlTransport, TransportError, type HttpAuth, type Transport } from "./curl.js";
import { AuthError, EwsClient, EwsError, normalizeEwsUrl } from "./ews/client.js";
import type { ParsedMessage, ParsedSummary } from "./ews/parse.js";
import type { Address, FolderName, ItemRef } from "./ews/soap.js";
import { readJson, removeFile, serial, writeJson } from "./files.js";
import { formatDraft, formatList, formatMessage } from "./format.js";
import { openSecretStore, type SecretStore } from "./secret-store.js";

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
  /** Set when Exchange refused the password: retrying every agent call would lock the account. */
  blocked?: string | null;
}

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
  if (error instanceof UserError || error instanceof AuthError || error instanceof TransportError || error instanceof EwsError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export class MailService {
  private readonly dataDir: string;
  private readonly transport: Transport;
  private readonly secrets: SecretStore;
  private readonly platform: NodeJS.Platform;
  private readonly offset: number | undefined;
  private readonly writeDrafts = serial();
  private readonly writeRefs = serial();
  private refs: Map<string, string> | null = null;
  private refsDirty: NodeJS.Timeout | null = null;

  constructor(options: MailServiceOptions) {
    this.dataDir = options.dataDir;
    this.transport = options.transport ?? curlTransport({ platform: options.platform });
    this.secrets = options.secrets ?? openSecretStore("auto", options.platform);
    this.platform = options.platform ?? process.platform;
    this.offset = options.utcOffsetMinutes;
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
  private draftsFile = () => join(this.dataDir, "drafts.json");
  private refsFile = () => join(this.dataDir, "refs.json");

  private readConnection = () => readJson<Connection>(this.connectionFile());

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
    const hasPassword = connection?.auth === "password" ? await this.secrets.has(PASSWORD).catch(() => false) : false;
    return {
      platform: this.platform,
      curl,
      curlError,
      url: connection?.url ?? null,
      auth: connection?.auth ?? null,
      user: connection?.user ?? null,
      hasPassword,
      passwordStore: this.secrets.label,
      blocked: connection?.blocked ?? null,
      lastCheck: connection?.lastCheck ?? null,
    };
  }

  async saveConnection(input: { url: string; auth: AuthMode; user?: string; password?: string }): Promise<ConnectionStatus> {
    let url: string;
    try {
      url = normalizeEwsUrl(input.url);
    } catch (error) {
      throw new UserError(describe(error));
    }
    const previous = await this.readConnection();
    let user: string | null = null;
    if (input.auth === "password") {
      user = (input.user ?? "").trim();
      if (!user) throw new UserError("Enter the login, for example DOMAIN\\name or name@company.com");
      if (input.password) await this.secrets.set(PASSWORD, Buffer.from(input.password, "utf8").toString("base64"));
      else if (!(await this.secrets.has(PASSWORD))) throw new UserError("Enter the password");
    } else {
      await this.secrets.delete(PASSWORD).catch(() => false);
    }
    const sameTarget = previous && previous.url === url && previous.auth === input.auth && previous.user === user && !input.password;
    // A new password, login or address lifts the pause; saving the same settings again does not.
    await writeJson(this.connectionFile(), {
      url,
      auth: input.auth,
      user,
      lastCheck: sameTarget ? previous.lastCheck : null,
      blocked: sameTarget ? (previous.blocked ?? null) : null,
    } satisfies Connection);
    return this.status();
  }

  async forget(): Promise<ConnectionStatus> {
    await this.secrets.delete(PASSWORD).catch(() => false);
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
    if (!connection) throw new UserError("Mail is not connected on this machine yet. Connect it in the Exchange Mail panel.");
    let auth: HttpAuth;
    if (connection.auth === "negotiate") auth = { kind: "negotiate" };
    else {
      if (connection.blocked && !options.retry) {
        throw new UserError(`Mail sign-in is paused: ${connection.blocked} Enter the password again in the Exchange Mail panel, or press Try once more there.`);
      }
      const stored = await this.secrets.get(PASSWORD);
      if (!stored || !connection.user) throw new UserError("The mail password is missing on this machine. Enter it again in the Exchange Mail panel.");
      auth = { kind: "ntlm", user: connection.user, password: Buffer.from(stored, "base64").toString("utf8") };
    }
    const block = async (message: string) => {
      const latest = await this.readConnection();
      if (latest && latest.url === connection.url && latest.user === connection.user && latest.auth === "password") {
        await writeJson(this.connectionFile(), { ...latest, blocked: message });
      }
    };
    return new EwsClient({ url: connection.url, auth, transport: this.transport, onAuthFailure: connection.auth === "password" ? block : undefined });
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
    if (latest && latest.url === connection.url && latest.auth === connection.auth) {
      await writeJson(this.connectionFile(), {
        ...latest,
        ...(result.ok ? { blocked: null } : {}),
        lastCheck: { ok: result.ok, at: Date.now(), message: result.message },
      });
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

  async draft(id: string, signal?: AbortSignal): Promise<Draft | null> {
    const entry = (await this.readDrafts()).find((d) => d.id === id);
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
    if (!previous && entries.length >= MAX_DRAFTS) throw new UserError("Too many drafts are waiting. Send or discard some in the Exchange Mail panel first.");

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
      createdAt: Date.now(),
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

  async discardDraft(id: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    const entry = (await this.readDrafts()).find((d) => d.id === id);
    if (!entry) return { ok: false };
    const client = await this.client();
    await client.delete({ id: entry.itemId }, signal).catch((error) => {
      if (!(error instanceof EwsError && error.code === "ErrorItemNotFound")) throw error;
    });
    await this.writeDrafts(async () => writeJson(this.draftsFile(), (await this.readDrafts()).filter((d) => d.id !== id)));
    return { ok: true };
  }

  /**
   * Sends a draft only at the version the person saw: the change key the panel
   * showed must still be the draft's change key. Anything that touched the
   * draft since — an agent revising it, an edit in Outlook — changes the key.
   */
  async send(id: string, revision: string, signal?: AbortSignal): Promise<SendResult> {
    const entry = (await this.readDrafts()).find((d) => d.id === id);
    if (!entry) return { status: "gone", message: "This draft is no longer waiting: it was sent, discarded or replaced." };
    const client = await this.client();
    let current: ItemRef;
    try {
      current = await client.currentId({ id: entry.itemId }, signal);
    } catch (error) {
      if (error instanceof EwsError && error.code === "ErrorItemNotFound") {
        await this.writeDrafts(async () => writeJson(this.draftsFile(), (await this.readDrafts()).filter((d) => d.id !== id)));
        return { status: "gone", message: "The draft is not in Drafts any more: it was sent or deleted in Outlook." };
      }
      throw error;
    }
    if (current.changeKey !== revision) {
      return { status: "changed", message: "The draft changed after you opened it. Review the new version before sending." };
    }
    try {
      await client.send({ id: entry.itemId, changeKey: revision }, signal);
    } catch (error) {
      if (error instanceof EwsError && /Stale|Conflict|ChangeKey/i.test(error.code)) {
        return { status: "changed", message: "The draft changed after you opened it. Review the new version before sending." };
      }
      throw error;
    }
    await this.writeDrafts(async () => writeJson(this.draftsFile(), (await this.readDrafts()).filter((d) => d.id !== id)));
    return { status: "sent", at: Date.now() };
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
