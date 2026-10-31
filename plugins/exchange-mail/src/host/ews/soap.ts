// EWS SOAP requests. Only the operations the plugin needs: list and search a
// folder, read a message, save a draft (new, reply, reply all), send a saved
// draft, delete a draft, read folder counters.
//
// Every request is plain ASCII: characters outside it become XML character
// references, so no code page between Node, curl and Exchange can mangle them.

export type FolderName = "inbox" | "sentitems" | "drafts" | "deleteditems";

export interface ItemRef {
  readonly id: string;
  readonly changeKey?: string | null;
}

export interface Address {
  readonly name: string | null;
  readonly email: string;
}

const NS =
  'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" ' +
  'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"';

/** Escapes text for XML and turns everything outside printable ASCII into character references. */
export function xml(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else if (char === "'") out += "&apos;";
    else if (code === 0x09 || code === 0x0a || code === 0x0d) out += code === 0x0a ? "\n" : `&#x${code.toString(16)};`;
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffe || code === 0xffff) continue; // not allowed in XML 1.0
    else if (code > 0x7e) out += `&#x${code.toString(16)};`;
    else out += char;
  }
  return out;
}

export function envelope(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<soap:Envelope ${NS}><soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>` +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}

const field = (uri: string) => `<t:FieldURI FieldURI="${uri}"/>`;
const itemId = (ref: ItemRef, tag = "t:ItemId") =>
  `<${tag} Id="${xml(ref.id)}"${ref.changeKey ? ` ChangeKey="${xml(ref.changeKey)}"` : ""}/>`;
const folderId = (folder: FolderName) => `<t:DistinguishedFolderId Id="${folder}"/>`;

const SUMMARY_FIELDS = [
  "item:Subject",
  "message:From",
  "item:DateTimeReceived",
  "message:IsRead",
  "item:HasAttachments",
  "item:Preview",
  "item:DisplayTo",
];

export interface FindOptions {
  readonly folder: FolderName;
  readonly offset: number;
  readonly limit: number;
  readonly unreadOnly?: boolean;
  /** Advanced Query Syntax, as in the Outlook search box. */
  readonly query?: string;
}

export function findItems(options: FindOptions): string {
  const restriction =
    options.unreadOnly && !options.query
      ? `<m:Restriction><t:IsEqualTo>${field("message:IsRead")}<t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>`
      : "";
  return envelope(
    `<m:FindItem Traversal="Shallow">` +
      `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${SUMMARY_FIELDS.map(field).join("")}</t:AdditionalProperties></m:ItemShape>` +
      `<m:IndexedPageItemView MaxEntriesReturned="${options.limit}" Offset="${options.offset}" BasePoint="Beginning"/>` +
      restriction +
      `<m:SortOrder><t:FieldOrder Order="Descending">${field("item:DateTimeReceived")}</t:FieldOrder></m:SortOrder>` +
      `<m:ParentFolderIds>${folderId(options.folder)}</m:ParentFolderIds>` +
      (options.query ? `<m:QueryString>${xml(options.query)}</m:QueryString>` : "") +
      `</m:FindItem>`,
  );
}

const MESSAGE_FIELDS = [
  "item:Subject",
  "message:From",
  "message:ToRecipients",
  "message:CcRecipients",
  "item:DateTimeReceived",
  "item:DateTimeSent",
  "message:IsRead",
  "item:HasAttachments",
  "item:Attachments",
  "item:Body",
  "item:IsDraft",
  "message:InternetMessageId",
];

/** A whole message with its body converted to plain text by Exchange. */
export function getItem(ref: ItemRef): string {
  return envelope(
    `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:BodyType>Text</t:BodyType>` +
      `<t:AdditionalProperties>${MESSAGE_FIELDS.map(field).join("")}</t:AdditionalProperties></m:ItemShape>` +
      `<m:ItemIds>${itemId({ id: ref.id })}</m:ItemIds></m:GetItem>`,
  );
}

/** Just the current id and change key, before acting on an item. */
export function getItemId(ref: ItemRef): string {
  return envelope(
    `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:ItemIds>${itemId({ id: ref.id })}</m:ItemIds></m:GetItem>`,
  );
}

const mailboxes = (tag: string, list: readonly Address[] | undefined) =>
  list && list.length
    ? `<t:${tag}>${list
        .map((a) => `<t:Mailbox>${a.name ? `<t:Name>${xml(a.name)}</t:Name>` : ""}<t:EmailAddress>${xml(a.email)}</t:EmailAddress></t:Mailbox>`)
        .join("")}</t:${tag}>`
    : "";

export type DraftKind = "new" | "reply" | "replyAll";

export interface DraftInput {
  readonly kind: DraftKind;
  /** The message answered; required for replies. */
  readonly reference?: ItemRef;
  /** Replies: omitted keeps the recipients Exchange chooses. */
  readonly to?: readonly Address[];
  readonly cc?: readonly Address[];
  /** Replies: omitted keeps Exchange's "RE: …". */
  readonly subject?: string;
  /** The text written above the quoted message (replies) or the whole body (new). */
  readonly body: string;
}

/** Saves a draft in the Drafts folder; nothing is sent. */
export function createDraft(input: DraftInput): string {
  const save = `<m:SavedItemFolderId>${folderId("drafts")}</m:SavedItemFolderId>`;
  if (input.kind === "new") {
    return envelope(
      `<m:CreateItem MessageDisposition="SaveOnly">${save}<m:Items><t:Message>` +
        `<t:Subject>${xml(input.subject ?? "")}</t:Subject>` +
        `<t:Body BodyType="Text">${xml(input.body)}</t:Body>` +
        mailboxes("ToRecipients", input.to) +
        mailboxes("CcRecipients", input.cc) +
        `</t:Message></m:Items></m:CreateItem>`,
    );
  }
  if (!input.reference) throw new Error("A reply needs the message it answers");
  const tag = input.kind === "reply" ? "ReplyToItem" : "ReplyAllToItem";
  return envelope(
    `<m:CreateItem MessageDisposition="SaveOnly">${save}<m:Items><t:${tag}>` +
      (input.subject !== undefined ? `<t:Subject>${xml(input.subject)}</t:Subject>` : "") +
      mailboxes("ToRecipients", input.to) +
      mailboxes("CcRecipients", input.cc) +
      itemId(input.reference, "t:ReferenceItemId") +
      `<t:NewBodyContent BodyType="Text">${xml(input.body)}</t:NewBodyContent>` +
      `</t:${tag}></m:Items></m:CreateItem>`,
  );
}

/** Sends a saved draft exactly at the given change key and keeps a copy in Sent Items. */
export function sendItem(ref: ItemRef): string {
  if (!ref.changeKey) throw new Error("Sending needs the change key the person saw");
  return envelope(
    `<m:SendItem SaveItemToFolder="true"><m:ItemIds>${itemId(ref)}</m:ItemIds>` +
      `<m:SavedItemFolderId>${folderId("sentitems")}</m:SavedItemFolderId></m:SendItem>`,
  );
}

export function deleteItem(ref: ItemRef): string {
  return envelope(`<m:DeleteItem DeleteType="MoveToDeletedItems"><m:ItemIds>${itemId({ id: ref.id })}</m:ItemIds></m:DeleteItem>`);
}

export function markRead(ref: ItemRef, isRead: boolean): string {
  return envelope(
    `<m:UpdateItem ConflictResolution="AlwaysOverwrite" MessageDisposition="SaveOnly" SuppressReadReceipts="true"><m:ItemChanges><t:ItemChange>` +
      itemId({ id: ref.id }) +
      `<t:Updates><t:SetItemField>${field("message:IsRead")}<t:Message><t:IsRead>${isRead}</t:IsRead></t:Message></t:SetItemField></t:Updates>` +
      `</t:ItemChange></m:ItemChanges></m:UpdateItem>`,
  );
}

export function getFolder(folder: FolderName): string {
  return envelope(
    `<m:GetFolder><m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape><m:FolderIds>${folderId(folder)}</m:FolderIds></m:GetFolder>`,
  );
}
