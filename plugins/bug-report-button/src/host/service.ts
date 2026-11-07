// What the host entry does, apart from bb's RPC plumbing so tests can drive it: keep the key, find a shared one,
// and send a request with it to the configured address only.
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { Answer, Auth, FailureCode, KeyStatus } from "../../contract";
import { openSecretStore, type SecretStore } from "./secret-store";

export const OWN_SERVICE = "bb-bug-report-button";
const SECRET = "api-key";
const TIMEOUT_MS = 60_000;
const MAX_ANSWER_CHARS = 200_000;

type State = { origin: string | null };

export function originOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("not http(s)");
  return url.origin;
}

/** The full address of one request: the path stays under the configured address. */
export function requestUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /(^|\/)\.\.(\/|$)/.test(path)) throw new TypeError("bad path");
  const url = new URL(base + path);
  if (url.origin !== originOf(base) || !url.pathname.startsWith(new URL(base).pathname.replace(/\/+$/, ""))) throw new TypeError("path leaves the address");
  return url.toString();
}

export function failureOf(status: number): FailureCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 413) return "tooLarge";
  if (status >= 300 && status < 400) return "redirect";
  if (status >= 500) return "serverError";
  return "badRequest";
}

export type HostOptions = {
  dataDir: string;
  /** Tests only. */
  store?: SecretStore;
  sharedStore?: (plugin: string) => SecretStore;
  fetcher?: typeof fetch;
};

export class ReportHost {
  readonly #dataDir: string;
  readonly #store: SecretStore;
  readonly #sharedStore: (plugin: string) => SecretStore;
  readonly #fetch: typeof fetch;

  constructor(options: HostOptions) {
    this.#dataDir = options.dataDir;
    this.#store = options.store ?? openSecretStore(OWN_SERVICE);
    this.#sharedStore = options.sharedStore ?? ((plugin) => openSecretStore(`bb-${plugin}`));
    this.#fetch = options.fetcher ?? fetch;
  }

  async #state(dir: string): Promise<State> {
    try {
      const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { origin?: unknown };
      return { origin: typeof raw.origin === "string" ? raw.origin : null };
    } catch {
      return { origin: null };
    }
  }

  async #saveState(state: State): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true });
    const temporary = join(this.#dataDir, `.state.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temporary, JSON.stringify(state), "utf8");
    await rename(temporary, join(this.#dataDir, "state.json"));
  }

  /** The other plugin's data directory on this machine: bb keeps host data at <data>/plugins/<id>/host-data. */
  #sharedDir(plugin: string): string {
    return resolve(this.#dataDir, "..", "..", plugin, "host-data");
  }

  /** The key for this address: our own if it was saved for it, else the shared plugin's, if saved for the same one. */
  async #key(baseUrl: string, shareWith: string | null): Promise<{ key: string; source: "own" | "shared"; store: SecretStore } | null> {
    const origin = originOf(baseUrl);
    if ((await this.#state(this.#dataDir)).origin === origin) {
      const stored = await this.#store.get(SECRET);
      if (stored) return { key: Buffer.from(stored, "base64").toString("utf8"), source: "own", store: this.#store };
    }
    if (shareWith && (await this.#state(this.#sharedDir(shareWith))).origin === origin) {
      const store = this.#sharedStore(shareWith);
      const stored = await store.get(SECRET);
      if (stored) return { key: Buffer.from(stored, "base64").toString("utf8"), source: "shared", store };
    }
    return null;
  }

  async status(baseUrl: string, shareWith: string | null): Promise<KeyStatus> {
    const found = await this.#key(baseUrl, shareWith).catch(() => null);
    return { hasKey: Boolean(found), source: found?.source ?? null, keyStore: found ? found.store.kind : null };
  }

  async saveKey(baseUrl: string, shareWith: string | null, key: string): Promise<KeyStatus> {
    const clean = key.trim();
    if (clean === "" || /[\r\n]/.test(clean)) throw new Error("The key must be one line");
    // Base64 keeps any key intact in stores that are picky about characters, as Tracker Board does.
    await this.#store.set(SECRET, Buffer.from(clean, "utf8").toString("base64"));
    await this.#saveState({ origin: originOf(baseUrl) });
    return this.status(baseUrl, shareWith);
  }

  /** Forgets only our own key: the shared one belongs to the other plugin. */
  async forget(baseUrl: string, shareWith: string | null): Promise<KeyStatus> {
    await this.#store.delete(SECRET);
    await this.#saveState({ origin: null });
    return this.status(baseUrl, shareWith);
  }

  async post(input: { baseUrl: string; shareWith: string | null; auth: Auth; path: string; body: BodyInit; type: string | null }, signal?: AbortSignal): Promise<Answer> {
    const refused = (code: FailureCode, detail: string | null = null): Answer => ({ ok: false, code, status: null, detail });
    let url: string;
    try {
      url = requestUrl(input.baseUrl, input.path);
    } catch {
      return refused("badAddress");
    }
    let found;
    try {
      found = await this.#key(input.baseUrl, input.shareWith);
    } catch {
      return refused("storeError");
    }
    if (!found) return refused("noKey");
    const headers: Record<string, string> = { Accept: "application/json", [input.auth.header]: input.auth.format.replace("{key}", found.key) };
    if (input.type) headers["Content-Type"] = input.type;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      // A redirect is not followed: it would carry the key to another address.
      const response = await this.#fetch(url, { method: "POST", headers, body: input.body, redirect: "manual", signal: controller.signal });
      const text = (await response.text()).slice(0, MAX_ANSWER_CHARS);
      if (response.ok) return { ok: true, status: response.status, text };
      return { ok: false, code: failureOf(response.status), status: response.status, detail: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || null };
    } catch (error) {
      if (controller.signal.aborted) return refused("timeout");
      const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
      return refused("unreachable", cause.slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
  }
}
