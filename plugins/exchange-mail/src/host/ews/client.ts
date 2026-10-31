// Exchange Web Services operations over a Transport.
import { TransportError, type HttpAuth, type Transport } from "../curl.js";
import { EwsError, parseCreateItem, parseFindItems, parseGetAttachment, parseGetFolder, parseGetItem, parseGetItemId, parseResolveNames, parseSimple } from "./parse.js";
import * as soap from "./soap.js";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: "auth-refused" | "auth-negotiate",
  ) {
    super(message);
  }
}

/** The address typed for Exchange is not one bb will use. */
export class UrlError extends Error {
  constructor(
    message: string,
    readonly code: "bad-address" | "https-required" | "login-in-address",
  ) {
    super(message);
  }
}

export interface EwsClientOptions {
  readonly url: string;
  readonly auth: HttpAuth;
  readonly transport: Transport;
  /** Called when Exchange refuses the sign-in, before AuthError is thrown. */
  readonly onAuthFailure?: (message: string) => Promise<void>;
}

/** Lets a test server on this machine use plain http. Never on by default. */
export const DEV_HTTP_FLAG = "EXCHANGE_MAIL_DEV_ALLOW_LOCAL_HTTP";

/**
 * Normalizes the EWS address: https only, path defaults to /EWS/Exchange.asmx.
 * Plain http to this machine is allowed only with `allowLocalHttp`, for tests
 * and development against a stub.
 */
export function normalizeEwsUrl(input: string, options: { allowLocalHttp?: boolean } = {}): string {
  let url: URL;
  try {
    url = new URL(input.trim().includes("://") ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new UrlError("Enter the Exchange address, for example https://mail.example.com/EWS/Exchange.asmx", "bad-address");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  // Plain http would hand the sign-in to anyone on the network; only a test server on this machine, under the dev flag, may use it.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && options.allowLocalHttp === true)) {
    throw new UrlError("The Exchange address must start with https://", "https-required");
  }
  if (url.username || url.password) throw new UrlError("Do not put a login into the address", "login-in-address");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/EWS/Exchange.asmx";
  url.hash = "";
  return url.toString();
}

export class EwsClient {
  constructor(private readonly options: EwsClientOptions) {}

  private async call(body: string, signal?: AbortSignal): Promise<string> {
    const response = await this.options.transport.send({ url: this.options.url, body, auth: this.options.auth, signal });
    if (response.status === 401) {
      const message =
        this.options.auth.kind === "negotiate"
          ? "Exchange did not accept the automatic sign-in. On Windows this works on a domain laptop signed in with the work account; otherwise sign in with a password."
          : "Exchange did not accept the login and password.";
      await this.options.onAuthFailure?.(message);
      throw new AuthError(message, this.options.auth.kind === "negotiate" ? "auth-negotiate" : "auth-refused");
    }
    if (response.status === 200 || response.status === 500) {
      if (/<(?:\w+:)?Envelope[\s>]/.test(response.body)) return response.body;
    }
    if (response.status === 0) throw new TransportError("failed", "Exchange gave no answer");
    if (response.status >= 300 && response.status < 400) {
      throw new EwsError("Redirect", `Exchange redirected the request (HTTP ${response.status}). Check the address: it should end with /EWS/Exchange.asmx.`);
    }
    if (response.status === 404) throw new EwsError("NotFound", "There is no Exchange Web Services at this address (HTTP 404).");
    if (response.status === 403) throw new EwsError("Forbidden", "Exchange refused access to Exchange Web Services for this account (HTTP 403).");
    throw new EwsError("Http", `Exchange answered HTTP ${response.status}.`);
  }

  async folderCounts(folder: soap.FolderName, signal?: AbortSignal) {
    return parseGetFolder(await this.call(soap.getFolder(folder), signal));
  }

  async find(options: soap.FindOptions, signal?: AbortSignal) {
    return parseFindItems(await this.call(soap.findItems(options), signal));
  }

  async get(ref: soap.ItemRef, signal?: AbortSignal, options: { html?: boolean } = {}) {
    return parseGetItem(await this.call(soap.getItem(ref, options), signal));
  }

  async attachment(attachmentId: string, signal?: AbortSignal) {
    return parseGetAttachment(await this.call(soap.getAttachment(attachmentId), signal));
  }

  async currentId(ref: soap.ItemRef, signal?: AbortSignal) {
    return parseGetItemId(await this.call(soap.getItemId(ref), signal));
  }

  async createDraft(input: soap.DraftInput, signal?: AbortSignal) {
    return parseCreateItem(await this.call(soap.createDraft(input), signal));
  }

  async send(ref: soap.ItemRef, signal?: AbortSignal) {
    parseSimple(await this.call(soap.sendItem(ref), signal), "SendItem");
  }

  async delete(ref: soap.ItemRef, signal?: AbortSignal) {
    parseSimple(await this.call(soap.deleteItem(ref), signal), "DeleteItem");
  }

  async resolveNames(query: string, signal?: AbortSignal) {
    return parseResolveNames(await this.call(soap.resolveNames(query), signal));
  }

  async markRead(ref: soap.ItemRef, isRead: boolean, signal?: AbortSignal) {
    parseSimple(await this.call(soap.markRead(ref, isRead), signal), "UpdateItem");
  }
}

export { EwsError };
