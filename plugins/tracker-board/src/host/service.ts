// Everything the host entry does, independent of bb's RPC plumbing so tests can
// drive it directly: keep the key, and send one request with it.
import type { FailureCode, KeyStatus, RequestInput, RequestOutput } from "../../contract.js";
import { normalizeBaseUrl, ProfileError } from "../shared/profile.js";
import { httpSend } from "./http.js";
import { openSecretStore, type SecretStore } from "./secret-store.js";
import { StateFile } from "./state.js";

const SECRET = "api-key";

export interface ServiceOptions {
  readonly dataDir: string;
  /** Tests only. */
  readonly store?: SecretStore;
}

function originOf(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl)).origin;
}

/** The full address of one request. The path stays under the configured address. */
export function requestUrl(baseUrl: string, path: string, query: Record<string, string>): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new ProfileError("A request path must start with a single /");
  const url = new URL(base + path);
  if (url.origin !== new URL(base).origin) throw new ProfileError("A request path must stay on the tracker address");
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
}

export class TrackerHost {
  readonly state: StateFile;
  readonly #store: SecretStore;

  constructor(options: ServiceOptions) {
    this.state = new StateFile(options.dataDir);
    this.#store = options.store ?? openSecretStore();
  }

  async status(baseUrl: string | null): Promise<KeyStatus> {
    const state = await this.state.load();
    const hasKey = state.origin !== null && (await this.#store.has(SECRET));
    let addressChanged = false;
    try {
      addressChanged = state.origin !== null && baseUrl !== null && originOf(baseUrl) !== state.origin;
    } catch {
      addressChanged = true;
    }
    return { platform: process.platform, hasKey, keyStore: hasKey ? this.#store.kind : null, addressChanged, lastCheck: state.lastCheck };
  }

  async saveKey(input: { baseUrl: string; key: string }): Promise<KeyStatus> {
    const key = input.key.trim();
    if (key === "" || /[\r\n]/.test(key)) throw new Error("The key must be one line");
    const origin = originOf(input.baseUrl);
    // Base64 keeps any key intact in stores that are picky about characters.
    await this.#store.set(SECRET, Buffer.from(key, "utf8").toString("base64"));
    await this.state.update(() => ({ origin, lastCheck: null }));
    return this.status(input.baseUrl);
  }

  async forget(baseUrl: string | null): Promise<KeyStatus> {
    await this.#store.delete(SECRET);
    await this.state.update(() => ({ origin: null, lastCheck: null }));
    return this.status(baseUrl);
  }

  async recordCheck(input: { ok: boolean; code: FailureCode | null; status: number | null }): Promise<KeyStatus> {
    const state = await this.state.update((current) => ({ ...current, lastCheck: { ...input, at: Date.now() } }));
    return this.status(state.origin);
  }

  async request(input: RequestInput, signal?: AbortSignal): Promise<RequestOutput> {
    const refused = (code: FailureCode): RequestOutput => ({ ok: false, code, status: null, detail: null });
    const state = await this.state.load();
    if (!state.origin) return refused("noKey");
    let url: string;
    try {
      if (originOf(input.baseUrl) !== state.origin) return refused("addressChanged");
      url = requestUrl(input.baseUrl, input.path, input.query);
    } catch (error) {
      if (error instanceof ProfileError || error instanceof TypeError) return refused("badAddress");
      throw error;
    }
    let key: string | null;
    try {
      const stored = await this.#store.get(SECRET);
      key = stored === null ? null : Buffer.from(stored, "base64").toString("utf8");
    } catch {
      return refused("storeError");
    }
    if (!key) return refused("noKey");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers)) {
      // The configuration cannot overwrite the key's header or smuggle another key in.
      if (name.toLowerCase() !== input.auth.header.toLowerCase() && name.toLowerCase() !== "cookie") headers[name] = value;
    }
    headers[input.auth.header] = input.auth.format.replace("{key}", key);
    return httpSend({ url, method: input.method, headers, body: input.body, exposeHeaders: input.exposeHeaders }, signal ? { signal } : {});
  }
}
