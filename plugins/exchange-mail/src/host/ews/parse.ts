// Reading EWS SOAP answers. Namespaces are dropped; every value stays a string.
import { XMLParser } from "fast-xml-parser";
import { normalizeText } from "../../shared/mail-text.js";
import { isAddress } from "../../shared/recipients.js";
import type { Address, ItemRef } from "./soap.js";

export class EwsError extends Error {
  constructor(
    /** EWS response code (ErrorItemNotFound…) or "SoapFault" / "BadResponse". */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ARRAYS = new Set(["Mailbox", "FileAttachment", "ItemAttachment", "ReferenceAttachment", "ExtendedProperty", "Resolution", "Entry"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  // Exchange writes line breaks as &#xD; and may write any character as a numeric reference: decode them all.
  htmlEntities: true,
  isArray: (name) => ARRAYS.has(name),
});

type Node = Record<string, unknown>;

const asNode = (value: unknown): Node | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Node) : null);
const list = (value: unknown): Node[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(asNode).filter((n): n is Node => n !== null);

/** Text of a leaf that may carry attributes. */
export function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const node = asNode(value);
  if (node && "#text" in node) return text(node["#text"]);
  return "";
}

const bool = (value: unknown) => text(value).trim().toLowerCase() === "true";

/**
 * The single response message of an operation, after checking for SOAP faults
 * and EWS errors. With `warnings`, a Warning answer is a result too: ResolveNames
 * says "several people match" that way.
 */
export function responseMessage(xmlText: string, operation: string, options: { warnings?: boolean } = {}): Node {
  let doc: Node;
  try {
    doc = parser.parse(xmlText) as Node;
  } catch {
    throw new EwsError("BadResponse", "Exchange answered with something that is not XML");
  }
  const body = asNode(asNode(doc.Envelope)?.Body);
  if (!body) throw new EwsError("BadResponse", "Exchange answered without a SOAP body");
  const fault = asNode(body.Fault);
  if (fault) {
    const detail = asNode(fault.detail);
    const code = text(detail?.ResponseCode) || "SoapFault";
    const message = text(detail?.Message) || text(fault.faultstring) || "Exchange refused the request";
    throw new EwsError(code, message.trim());
  }
  const response = asNode(body[`${operation}Response`]);
  const messages = asNode(response?.ResponseMessages);
  const message = asNode(messages?.[`${operation}ResponseMessage`]) ?? list(messages?.[`${operation}ResponseMessage`])[0] ?? null;
  if (!message) throw new EwsError("BadResponse", `Exchange answered without a ${operation} result`);
  const status = text(message["@ResponseClass"]);
  if (status !== "Success" && !(options.warnings && status === "Warning")) {
    const code = text(message.ResponseCode) || "Error";
    throw new EwsError(code, (text(message.MessageText) || code).trim());
  }
  return message;
}

function address(node: unknown): Address | null {
  const mailbox = list(asNode(node)?.Mailbox)[0] ?? asNode(node);
  if (!mailbox) return null;
  const email = text(mailbox.EmailAddress).trim();
  const name = text(mailbox.Name).trim();
  if (!email && !name) return null;
  return { name: name || null, email };
}

const addresses = (node: unknown): Address[] => list(asNode(node)?.Mailbox).map(address).filter((a): a is Address => a !== null);

function ref(node: unknown): ItemRef {
  const id = asNode(node);
  return { id: text(id?.["@Id"]), changeKey: text(id?.["@ChangeKey"]) || null };
}

export interface ParsedSummary {
  readonly item: ItemRef;
  /** Messages of one conversation share it. Null from servers that do not say. */
  readonly conversationId: string | null;
  readonly kind: string;
  readonly subject: string;
  readonly from: Address | null;
  readonly received: string | null;
  readonly isRead: boolean;
  readonly hasAttachments: boolean;
  readonly preview: string;
  readonly displayTo: string;
}

/** Items of any type (Message, MeetingRequest, …) as they come in a folder. */
function items(container: unknown): { kind: string; node: Node }[] {
  const out: { kind: string; node: Node }[] = [];
  const node = asNode(container);
  if (!node) return out;
  for (const [kind, value] of Object.entries(node)) {
    if (kind.startsWith("@") || kind === "#text") continue;
    for (const item of list(value)) out.push({ kind, node: item });
  }
  return out;
}

function summary(kind: string, node: Node): ParsedSummary {
  return {
    item: ref(node.ItemId),
    conversationId: text(asNode(node.ConversationId)?.["@Id"]) || null,
    kind,
    subject: text(node.Subject),
    from: address(node.From),
    received: text(node.DateTimeReceived) || null,
    isRead: node.IsRead === undefined ? true : bool(node.IsRead),
    hasAttachments: bool(node.HasAttachments),
    preview: previewOf(text(node.Preview)),
    displayTo: text(node.DisplayTo),
  };
}

/** One line for a list: whitespace runs and Exchange's written-out link targets go. */
function previewOf(value: string): string {
  return value
    .replace(/<(?:https?:\/\/|mailto:)[^\s<>]*>?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFindItems(xmlText: string): { items: ParsedSummary[]; total: number; last: boolean } {
  const message = responseMessage(xmlText, "FindItem");
  const root = asNode(message.RootFolder);
  const found = items(root?.Items).map(({ kind, node }) => summary(kind, node));
  return {
    items: found,
    total: Number(text(root?.["@TotalItemsInView"])) || found.length,
    last: text(root?.["@IncludesLastItemInRange"]).toLowerCase() !== "false",
  };
}

export type BodyFormat = "text" | "html" | "rtf" | "unknown";

/** PR_NATIVE_BODY_INFO from the item's extended properties. */
function bodyFormat(node: Node): BodyFormat {
  for (const property of list(node.ExtendedProperty)) {
    const uri = asNode(property.ExtendedFieldURI);
    const tag = text(uri?.["@PropertyTag"]).trim().toLowerCase();
    if (tag !== "0x1016" && tag !== "4118") continue;
    const value = Number(text(property.Value));
    return value === 1 ? "text" : value === 2 ? "rtf" : value === 3 ? "html" : "unknown";
  }
  return "unknown";
}

export interface ParsedAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number | null;
  /** "file" can be downloaded; "item" is an attached message, "reference" a link to a file elsewhere. */
  readonly kind: "file" | "item" | "reference";
  readonly contentType: string | null;
  readonly contentId: string | null;
  readonly isInline: boolean;
}

export interface ParsedMessage extends ParsedSummary {
  readonly to: Address[];
  readonly cc: Address[];
  readonly bcc: Address[];
  readonly bodyFormat: BodyFormat;
  readonly sent: string | null;
  readonly isDraft: boolean;
  /** Plain text: the body as asked for in text, or TextBody next to an HTML body. */
  readonly body: string;
  /** The HTML body, when it was asked for. Untrusted: the panel sanitizes it. */
  readonly html: string | null;
  readonly attachments: ParsedAttachment[];
  readonly internetMessageId: string | null;
}

function attachmentsOf(node: Node): ParsedAttachment[] {
  const container = asNode(node.Attachments);
  const of = (kind: ParsedAttachment["kind"], tag: string) =>
    list(container?.[tag]).map(
      (a): ParsedAttachment => ({
        id: text(asNode(a.AttachmentId)?.["@Id"]),
        name: text(a.Name) || "(attachment)",
        size: text(a.Size) ? Number(text(a.Size)) : null,
        kind,
        contentType: text(a.ContentType) || null,
        contentId: text(a.ContentId) || null,
        isInline: bool(a.IsInline),
      }),
    );
  return [...of("file", "FileAttachment"), ...of("item", "ItemAttachment"), ...of("reference", "ReferenceAttachment")];
}

export function parseGetItem(xmlText: string): ParsedMessage {
  const message = responseMessage(xmlText, "GetItem");
  const first = items(message.Items)[0];
  if (!first) throw new EwsError("ErrorItemNotFound", "The message is not in the mailbox any more");
  const { kind, node } = first;
  const bodyType = text(asNode(node.Body)?.["@BodyType"]).toLowerCase();
  const html = bodyType === "html" ? text(node.Body) : null;
  // Asked for as HTML: the text comes in TextBody (Exchange 2013 and later), else from the HTML itself.
  const plain = html === null ? text(node.Body) : node.TextBody !== undefined ? text(node.TextBody) : htmlToText(html);
  return {
    ...summary(kind, node),
    to: addresses(node.ToRecipients),
    cc: addresses(node.CcRecipients),
    bcc: addresses(node.BccRecipients),
    bodyFormat: bodyFormat(node),
    sent: text(node.DateTimeSent) || null,
    isDraft: bool(node.IsDraft),
    body: plain.replace(/\r\n?/g, "\n"),
    html,
    attachments: attachmentsOf(node),
    internetMessageId: text(node.InternetMessageId) || null,
  };
}

/** HTML longer than this is cut before it becomes text, so one message or attachment cannot keep the machine busy. */
export const HTML_TEXT_MAX = 2_000_000;

/** Elements whose content is not text a person reads. */
const HIDDEN = new Set(["script", "style", "head", "title", "template"]);
/** Elements that end a line. */
const BLOCKS = new Set(["p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table"]);
const NAMED: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(nbsp|lt|gt|quot|apos|amp));/gi;

/** A character reference as text; one outside Unicode (or a lone surrogate, or NUL) becomes U+FFFD. */
function character(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\uFFFD";
}

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (_, decimal: string | undefined, hex: string | undefined, name: string | undefined) =>
    decimal !== undefined ? character(Number(decimal)) : hex !== undefined ? character(parseInt(hex, 16)) : NAMED[name!.toLowerCase()]!,
  );
}

const isTagStart = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 47 || code === 33 || code === 63;
const isNameChar = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);

/**
 * A rough text of an HTML body, for servers without TextBody and for HTML
 * attachments: block tags become line breaks. One pass from left to right,
 * each search starting where the previous one ended, so the time grows with
 * the length of the HTML and nothing an email holds can make it hang.
 */
export function htmlToText(input: string): string {
  const html = input.length > HTML_TEXT_MAX ? input.slice(0, HTML_TEXT_MAX) : input;
  // Lower case for finding closing tags; ASCII only, so every index stays the same.
  const lower = html.replace(/[A-Z]+/g, (run) => run.toLowerCase());
  const out: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) {
      out.push(html.slice(at));
      break;
    }
    out.push(html.slice(at, open));
    if (!isTagStart(html.charCodeAt(open + 1))) {
      out.push("<");
      at = open + 1;
      continue;
    }
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    // A tag that never ends: what follows is inside it, not text.
    if (close < 0) break;
    let name = open + 1;
    const ending = html.charCodeAt(name) === 47;
    if (ending) name++;
    let nameEnd = name;
    while (nameEnd < close && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    const tag = lower.slice(name, nameEnd);
    at = close + 1;
    if (!ending && HIDDEN.has(tag) && html.charCodeAt(close - 1) !== 47) {
      const end = lower.indexOf(`</${tag}`, at);
      if (end < 0) break;
      const endClose = html.indexOf(">", end);
      if (endClose < 0) break;
      at = endClose + 1;
    } else if (tag === "br" || (ending && BLOCKS.has(tag))) out.push("\n");
  }
  return normalizeText(decodeEntities(out.join("")));
}

export interface ParsedAttachmentContent {
  readonly name: string;
  readonly contentType: string | null;
  readonly content: Buffer;
}

export function parseGetAttachment(xmlText: string): ParsedAttachmentContent {
  const message = responseMessage(xmlText, "GetAttachment");
  const container = asNode(message.Attachments);
  const file = list(container?.FileAttachment)[0];
  if (!file) throw new EwsError("ErrorAttachmentNotFound", "This attachment cannot be downloaded: it is an attached message or a link to a file elsewhere");
  return { name: text(file.Name) || "attachment", contentType: text(file.ContentType) || null, content: Buffer.from(text(file.Content).replace(/\s+/g, ""), "base64") };
}

export function parseGetItemId(xmlText: string): ItemRef {
  const message = responseMessage(xmlText, "GetItem");
  const first = items(message.Items)[0];
  if (!first) throw new EwsError("ErrorItemNotFound", "The message is not in the mailbox any more");
  return ref(first.node.ItemId);
}

export function parseCreateItem(xmlText: string): ItemRef {
  const message = responseMessage(xmlText, "CreateItem");
  const first = items(message.Items)[0];
  if (!first) throw new EwsError("BadResponse", "Exchange saved the draft but did not say where");
  return ref(first.node.ItemId);
}

export function parseSimple(xmlText: string, operation: "SendItem" | "DeleteItem" | "UpdateItem"): void {
  responseMessage(xmlText, operation);
}

export function parseGetFolder(xmlText: string): { total: number; unread: number } {
  const message = responseMessage(xmlText, "GetFolder");
  const folder = items(message.Folders)[0]?.node;
  return { total: Number(text(folder?.TotalCount)) || 0, unread: Number(text(folder?.UnreadCount)) || 0 };
}

/** Someone from the address book: a person, a group, or one of the person's own contacts. */
export interface ParsedPerson {
  readonly name: string;
  readonly email: string;
  readonly title: string | null;
  readonly department: string | null;
  readonly company: string | null;
  readonly office: string | null;
  readonly kind: "person" | "group" | "contact";
}

const GROUP_TYPES = new Set(["publicdl", "privatedl", "groupmailbox"]);

/** An SMTP address from "SMTP:a@b", "smtp:a@b" or "a@b", checked as the host checks recipients; anything else (X.500 and the like) is not one. */
function smtp(value: string): string | null {
  const address = value.trim().replace(/^smtp:/i, "");
  return isAddress(address) ? address : null;
}

/** ResolveNames: no match is an empty list, several are a Warning with all of them. */
export function parseResolveNames(xmlText: string): { people: ParsedPerson[]; total: number } {
  let message: Node;
  try {
    message = responseMessage(xmlText, "ResolveNames", { warnings: true });
  } catch (error) {
    if (error instanceof EwsError && error.code === "ErrorNameResolutionNoResults") return { people: [], total: 0 };
    throw error;
  }
  const set = asNode(message.ResolutionSet);
  const people: ParsedPerson[] = [];
  for (const resolution of list(set?.Resolution)) {
    const mailbox = list(resolution.Mailbox)[0];
    const contact = asNode(resolution.Contact);
    const entries = list(asNode(contact?.EmailAddresses)?.Entry).map((entry) => text(entry));
    const email = smtp(text(mailbox?.EmailAddress)) ?? entries.map(smtp).find((a): a is string => a !== null) ?? null;
    if (!email) continue;
    const type = text(mailbox?.MailboxType).trim().toLowerCase();
    const field = (name: string) => text(contact?.[name]).trim() || null;
    people.push({
      name: field("DisplayName") ?? (text(mailbox?.Name).trim() || email),
      email,
      title: field("JobTitle"),
      department: field("Department"),
      company: field("CompanyName"),
      office: field("OfficeLocation"),
      kind: GROUP_TYPES.has(type) ? "group" : type === "contact" ? "contact" : "person",
    });
  }
  return { people, total: Number(text(set?.["@TotalItemsInView"])) || people.length };
}
