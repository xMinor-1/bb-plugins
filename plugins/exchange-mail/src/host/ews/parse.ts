// Reading EWS SOAP answers. Namespaces are dropped; every value stays a string.
import { XMLParser } from "fast-xml-parser";
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

const ARRAYS = new Set(["Mailbox", "FileAttachment", "ItemAttachment", "ReferenceAttachment"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: false,
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

/** The single response message of an operation, after checking for SOAP faults and EWS errors. */
export function responseMessage(xmlText: string, operation: string): Node {
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
  if (text(message["@ResponseClass"]) !== "Success") {
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
    kind,
    subject: text(node.Subject),
    from: address(node.From),
    received: text(node.DateTimeReceived) || null,
    isRead: node.IsRead === undefined ? true : bool(node.IsRead),
    hasAttachments: bool(node.HasAttachments),
    preview: text(node.Preview).replace(/\s+/g, " ").trim(),
    displayTo: text(node.DisplayTo),
  };
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

export interface ParsedMessage extends ParsedSummary {
  readonly to: Address[];
  readonly cc: Address[];
  readonly sent: string | null;
  readonly isDraft: boolean;
  readonly body: string;
  readonly attachments: { name: string; size: number | null }[];
  readonly internetMessageId: string | null;
}

export function parseGetItem(xmlText: string): ParsedMessage {
  const message = responseMessage(xmlText, "GetItem");
  const first = items(message.Items)[0];
  if (!first) throw new EwsError("ErrorItemNotFound", "The message is not in the mailbox any more");
  const { kind, node } = first;
  const attachmentsNode = asNode(node.Attachments);
  const attachments = [...list(attachmentsNode?.FileAttachment), ...list(attachmentsNode?.ItemAttachment), ...list(attachmentsNode?.ReferenceAttachment)].map((a) => ({
    name: text(a.Name) || "(attachment)",
    size: text(a.Size) ? Number(text(a.Size)) : null,
  }));
  return {
    ...summary(kind, node),
    to: addresses(node.ToRecipients),
    cc: addresses(node.CcRecipients),
    sent: text(node.DateTimeSent) || null,
    isDraft: bool(node.IsDraft),
    body: text(node.Body).replace(/\r\n/g, "\n"),
    attachments,
    internetMessageId: text(node.InternetMessageId) || null,
  };
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
