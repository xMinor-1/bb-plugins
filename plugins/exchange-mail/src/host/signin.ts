// Password sign-in without locking the person's domain account.
//
// A domain locks an account after a few refused passwords in a short window,
// and Outlook, a phone and bb may all be trying the same stale password at
// once. So, for password sign-in:
//
//   1. After Exchange refuses a login, nothing tries that login again for
//      RETRY_AFTER_MS — not the panel, not an agent, not "Try again", not a new
//      password typed in. Then one attempt is allowed if the password changed
//      or someone asked to retry; the same refused password is never retried
//      on its own.
//   2. Requests with the password go one at a time, always — not only until
//      the first success. The domain can stop accepting the password at any
//      moment (it expired, someone changed it), and every request in flight
//      would then be one more refused attempt. So each request waits for the
//      answer to the one before it, and checks the pause again before it goes:
//      after the first 401 the rest are stopped here, not at the domain. The
//      panel loading the list and the folder counts together costs a little
//      speed for that.
//
// The pause is kept on disk per login, so restarting bb does not lift it, and
// it outlives Disconnect and a change of address.
import type { HttpRequest, HttpResponse, Transport } from "./curl.js";

export const RETRY_AFTER_MS = 15 * 60_000;

export interface Refusal {
  readonly at: number;
  /** The password version that was refused. */
  readonly version: string | null;
  readonly message: string;
}

export interface RefusalStore {
  get(login: string): Promise<Refusal | null>;
  set(login: string, refusal: Refusal | null): Promise<void>;
}

export interface Account {
  /** From `accountName`. */
  readonly login: string;
  readonly version: string | null;
  readonly url: string;
  /** The person asked to try once more. */
  readonly retry: boolean;
}

export class SignInPaused extends Error {
  constructor(
    message: string,
    /** "signin-paused": wait until retryAt; "signin-ask": a new password or Try again is needed. */
    readonly code: "signin-paused" | "signin-ask",
    readonly retryAt: number | null,
  ) {
    super(message);
  }
}

/** DOMAIN\name, name@company.com and NAME are one account: the pause must not depend on how the login was typed. */
export function accountName(user: string): string {
  const trimmed = user.trim().toLowerCase();
  const bare = trimmed.includes("\\") ? trimmed.slice(trimmed.lastIndexOf("\\") + 1) : trimmed;
  return bare.includes("@") ? bare.slice(0, bare.indexOf("@")) : bare;
}

const REFUSED = "Exchange did not accept the login and password.";

export class SignInGate {
  private readonly known = new Map<string, Refusal | null>();
  /** The request with the password that goes next waits for this one. */
  private line: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: RefusalStore,
    private readonly now: () => number,
    private readonly clock: (ms: number) => string = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  ) {}

  private async refusal(login: string): Promise<Refusal | null> {
    if (!this.known.has(login)) {
      const stored = await this.store.get(login);
      // Another request may have recorded a refusal while the file was read.
      if (!this.known.has(login)) this.known.set(login, stored);
    }
    return this.known.get(login) ?? null;
  }

  /** For the panel: why sign-in is paused and when it may be tried again. */
  async status(login: string): Promise<{ blocked: string | null; retryAt: number | null }> {
    const refusal = await this.refusal(login);
    return refusal ? { blocked: refusal.message, retryAt: refusal.at + RETRY_AFTER_MS } : { blocked: null, retryAt: null };
  }

  /** Null when a sign-in may be tried now, otherwise why not. */
  async check(account: Pick<Account, "login" | "version" | "retry">): Promise<SignInPaused | null> {
    const refusal = await this.refusal(account.login);
    if (!refusal) return null;
    const retryAt = refusal.at + RETRY_AFTER_MS;
    if (this.now() < retryAt) {
      return new SignInPaused(
        `Mail sign-in is paused: ${refusal.message} So that the domain does not lock the account, bb tries this login again ` +
          `no earlier than ${this.clock(retryAt)}, whoever asks. Check the password in Mail → Settings in the bb sidebar meanwhile.`,
        "signin-paused",
        retryAt,
      );
    }
    if (account.retry || account.version !== refusal.version) return null;
    return new SignInPaused(
      `Mail sign-in is paused: ${refusal.message} Enter the password again in Mail → Settings in the bb sidebar, or press Try again there.`,
      "signin-ask",
      null,
    );
  }

  transport(inner: Transport, account: Account): Transport {
    return { info: () => inner.info(), send: (request) => this.send(inner, account, request) };
  }

  private send(inner: Transport, account: Account, request: HttpRequest): Promise<HttpResponse> {
    const turn = this.line.then(() => this.sendAlone(inner, account, request));
    this.line = turn.catch(() => undefined);
    return turn;
  }

  private async sendAlone(inner: Transport, account: Account, request: HttpRequest): Promise<HttpResponse> {
    // Given up while waiting in line: nothing to send.
    request.signal?.throwIfAborted();
    // Read now, not when the request was made: the one before it may have just been refused.
    const paused = await this.check(account);
    if (paused) throw paused;
    const response = await inner.send(request);
    await this.record(account, response);
    return response;
  }

  private async record(account: Account, response: HttpResponse): Promise<void> {
    // Status 0 is no answer at all: nothing is known about the password.
    if (response.status === 0) return;
    if (response.status === 401) {
      const refusal: Refusal = { at: this.now(), version: account.version, message: REFUSED };
      this.known.set(account.login, refusal); // before any await: waiting requests must see it
      await this.store.set(account.login, refusal);
      return;
    }
    if (this.known.get(account.login)) {
      this.known.set(account.login, null);
      await this.store.set(account.login, null);
    }
  }
}
