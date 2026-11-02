// Everything the host entry does, independent of bb's RPC plumbing so tests can
// drive it directly: the sign-in, its check, and one read request.
import type { CheckResult, ConnectionStatus, FailureCode, RequestInput, RequestOutput } from "../../contract.js";
import { ConfigError, methodUrl, normalizeBaseUrl } from "../shared/service-config.js";
import { httpGet } from "./http.js";
import { openSecretStore, type SecretStore } from "./secret-store.js";
import { StateFile } from "./state.js";

const SECRET = "password";

export interface ServiceOptions {
  readonly dataDir: string;
  /** Tests only. */
  readonly store?: SecretStore;
}

/** A status that proves the service accepted the sign-in. A 5xx proves nothing: it can come from a proxy. */
const signedInStatus = (status: number | null) => status === 400 || status === 403 || status === 404;

export class DataService {
  readonly state: StateFile;
  readonly #store: SecretStore;
  /** Which password a request used. A refusal of an older password says nothing about the current one. */
  #generation = 0;
  /** The generation the service has accepted. Until then one request at a time tries the password. */
  #accepted: number | null = null;
  #trial: { generation: number; done: Promise<void> } | null = null;

  constructor(options: ServiceOptions) {
    this.state = new StateFile(options.dataDir);
    this.#store = options.store ?? openSecretStore();
  }

  async status(baseUrl: string | null): Promise<ConnectionStatus> {
    const state = await this.state.load();
    const hasPassword = state.user !== null && (await this.#store.has(SECRET));
    return {
      platform: process.platform,
      user: state.user,
      hasPassword,
      passwordStore: hasPassword ? this.#store.kind : null,
      blocked: state.blocked,
      addressChanged: state.origin !== null && baseUrl !== null && originOf(baseUrl) !== state.origin,
      lastCheck: state.lastCheck,
    };
  }

  async saveConnection(input: { baseUrl: string; user: string; password?: string }): Promise<ConnectionStatus> {
    const user = checkLogin(input.user);
    const origin = originOf(input.baseUrl);
    const before = await this.state.load();
    if (input.password === undefined && origin !== before.origin) {
      throw new Error("The service address changed: enter the password again to send it there");
    }
    // Base64 keeps any password intact in stores that are picky about characters.
    if (input.password !== undefined) await this.#store.set(SECRET, Buffer.from(input.password, "utf8").toString("base64"));
    const changed = input.password !== undefined || user !== before.user || origin !== before.origin;
    if (changed) this.#newGeneration();
    await this.state.update((state) => ({
      ...state,
      user,
      origin,
      // A new password or account is a fresh start for the sign-in guard.
      blocked: changed ? false : state.blocked,
      lastCheck: changed ? null : state.lastCheck,
    }));
    return this.status(input.baseUrl);
  }

  async forget(baseUrl: string | null): Promise<ConnectionStatus> {
    await this.#store.delete(SECRET);
    this.#newGeneration();
    await this.state.update(() => ({ user: null, origin: null, blocked: false, lastCheck: null }));
    return this.status(baseUrl);
  }

  /** Signs in with one read request. The answer is dropped: the panel gets only "worked" or why not. */
  async checkSignIn(input: { baseUrl: string; path: string; retry?: boolean }): Promise<CheckResult> {
    if (input.retry) {
      this.#newGeneration();
      await this.state.update((state) => ({ ...state, blocked: false }));
    }
    const generation = this.#generation;
    const result = await this.request({ baseUrl: input.baseUrl, path: input.path, query: {} });
    const outcome: CheckResult = result.ok ? { ok: true, code: null, status: null } : { ok: false, code: result.code, status: result.status };
    // Saved in the meantime: this answer is about the previous password.
    if (generation === this.#generation) await this.state.update((state) => ({ ...state, lastCheck: { ...outcome, at: Date.now() } }));
    return outcome;
  }

  async request(input: RequestInput, signal?: AbortSignal): Promise<RequestOutput> {
    const refused = (code: FailureCode): RequestOutput => ({ ok: false, code, status: null, detail: null });
    const state = await this.state.load();
    if (!state.user) return refused("noPassword");
    if (state.blocked) return refused("paused");
    let url: string;
    try {
      if (originOf(input.baseUrl) !== state.origin) return refused("addressChanged");
      url = methodUrl(input.baseUrl, input.path, input.query);
    } catch (error) {
      if (error instanceof ConfigError) return refused("badAddress");
      throw error;
    }
    let password: string | null;
    try {
      const stored = await this.#store.get(SECRET);
      password = stored === null ? null : Buffer.from(stored, "base64").toString("utf8");
    } catch {
      return refused("storeError");
    }
    if (!password) return refused("noPassword");
    const generation = this.#generation;
    if (this.#accepted === generation) return this.#send(url, state.user, password, generation, signal);
    // Nothing has proved this password yet: several agents at once must not each try a wrong one,
    // or the domain locks the account. The others wait, then look at the state again.
    if (this.#trial?.generation === generation) {
      await this.#trial.done;
      return this.request(input, signal);
    }
    const attempt = this.#send(url, state.user, password, generation, signal);
    const trial = { generation, done: attempt.then(() => undefined, () => undefined) };
    this.#trial = trial;
    void trial.done.then(() => {
      if (this.#trial === trial) this.#trial = null;
    });
    return attempt;
  }

  async #send(url: string, user: string, password: string, generation: number, signal: AbortSignal | undefined): Promise<RequestOutput> {
    const result = await httpGet(url, user, password, { ...(signal ? { signal } : {}) });
    if (generation !== this.#generation) return result;
    if (result.ok || signedInStatus(result.status)) {
      this.#accepted = generation;
    } else if (result.code === "unauthorized") {
      this.#accepted = null;
      // A refusal stays refused across restarts: a domain locks the account after a handful of failures.
      await this.state.update((current) => ({ ...current, blocked: true }));
    }
    return result;
  }

  #newGeneration(): void {
    this.#generation += 1;
    this.#accepted = null;
  }
}

function originOf(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl)).origin;
}

/** A login with a colon cannot be sent over HTTP Basic (RFC 7617). */
export function checkLogin(user: string): string {
  const trimmed = user.trim();
  if (trimmed === "" || trimmed.includes(":") || /[\x00-\x1f\x7f]/.test(trimmed)) throw new Error("The login must not be empty or contain a colon");
  return trimmed;
}
