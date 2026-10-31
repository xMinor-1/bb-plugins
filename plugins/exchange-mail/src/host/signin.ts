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
//   2. Until a sign-in is known to work, requests go one at a time: the first
//      one signs in and the rest wait for its answer instead of each sending
//      the same credentials (the panel loads the list and the drafts together).
//      A success is trusted for TRUST_MS; after that the next request checks
//      again alone.
//
// The pause is kept on disk per login, so restarting bb does not lift it, and
// it outlives Disconnect and a change of address.
import type { HttpRequest, HttpResponse, Transport } from "./curl.js";

export const RETRY_AFTER_MS = 15 * 60_000;
export const TRUST_MS = 60_000;

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

export class SignInPaused extends Error {}

/** DOMAIN\name, name@company.com and NAME are one account: the pause must not depend on how the login was typed. */
export function accountName(user: string): string {
  const trimmed = user.trim().toLowerCase();
  const bare = trimmed.includes("\\") ? trimmed.slice(trimmed.lastIndexOf("\\") + 1) : trimmed;
  return bare.includes("@") ? bare.slice(0, bare.indexOf("@")) : bare;
}

const REFUSED = "Exchange did not accept the login and password.";

export class SignInGate {
  private readonly known = new Map<string, Refusal | null>();
  private trusted: { key: string; at: number } | null = null;
  private probe: Promise<void> | null = null;

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
  async check(account: Pick<Account, "login" | "version" | "retry">): Promise<string | null> {
    const refusal = await this.refusal(account.login);
    if (!refusal) return null;
    const retryAt = refusal.at + RETRY_AFTER_MS;
    if (this.now() < retryAt) {
      return (
        `Mail sign-in is paused: ${refusal.message} So that the domain does not lock the account, bb tries this login again ` +
        `no earlier than ${this.clock(retryAt)}, whoever asks. Check the password in Mail → Settings in the bb sidebar meanwhile.`
      );
    }
    if (account.retry || account.version !== refusal.version) return null;
    return `Mail sign-in is paused: ${refusal.message} Enter the password again in Mail → Settings in the bb sidebar, or press Try again there.`;
  }

  /** Forget that a sign-in worked, for example after Disconnect. The pause stays. */
  reset(): void {
    this.trusted = null;
  }

  transport(inner: Transport, account: Account): Transport {
    return { info: () => inner.info(), send: (request) => this.send(inner, account, request) };
  }

  private async send(inner: Transport, account: Account, request: HttpRequest): Promise<HttpResponse> {
    const key = `${account.login}\n${account.version ?? ""}\n${account.url}`;
    for (;;) {
      // Someone is signing in right now: wait for that answer instead of sending the same credentials.
      if (this.probe) {
        await this.probe;
        continue;
      }
      if (this.trusted?.key === key && this.now() - this.trusted.at < TRUST_MS) {
        const response = await inner.send(request);
        await this.record(account, key, response);
        return response;
      }
      const why = await this.check(account);
      if (why) throw new SignInPaused(why);
      if (this.probe) continue; // another request became the probe while the pause was read
      let settle!: () => void;
      const probe = new Promise<void>((resolve) => (settle = resolve));
      this.probe = probe;
      try {
        const response = await inner.send(request);
        await this.record(account, key, response);
        return response;
      } finally {
        if (this.probe === probe) this.probe = null;
        settle();
      }
    }
  }

  private async record(account: Account, key: string, response: HttpResponse): Promise<void> {
    // Status 0 is no answer at all: nothing is known about the password.
    if (response.status === 0) return;
    if (response.status === 401) {
      this.trusted = null;
      const refusal: Refusal = { at: this.now(), version: account.version, message: REFUSED };
      this.known.set(account.login, refusal); // before any await: waiting requests must see it
      await this.store.set(account.login, refusal);
      return;
    }
    this.trusted = { key, at: this.now() };
    if (this.known.get(account.login)) {
      this.known.set(account.login, null);
      await this.store.set(account.login, null);
    }
  }
}
