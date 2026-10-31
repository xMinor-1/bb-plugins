// Sign-in through the standard Qlik Sense form (internal_forms_authentication)
// and the proxy session cookie that comes back.
import { AuthError } from "./engine.js";

export interface QlikConfig {
  /** `https://host[/virtual-proxy]/`, or null when tests talk to the engine directly. */
  readonly base: string | null;
  /** A bare engine socket (`ws://…`) for tests; skips the proxy and sign-in. */
  readonly engineUrl: string | null;
  readonly user: string | null;
  /** The agent's own engine session, so its selections never move a person's open tab. */
  readonly identity: string;
  /** Above this many values a filter value is looked up by search instead of a full scan. */
  readonly fullScanLimit: number;
}

/**
 * Remembers a refused sign-in across worker restarts. Every new agent session
 * would otherwise try the stale password again, and a domain locks the account
 * after a handful of failures — a password change on the domain side would do
 * exactly that.
 */
export interface SignInGuard {
  blockedReason(): string | null;
  block(reason: string): Promise<void>;
}

export interface Credentials {
  password(): Promise<string>;
}

class CookieJar {
  readonly map = new Map<string, string>();

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value) this.map.set(name, value);
      else this.map.delete(name);
    }
  }

  header(): string {
    return [...this.map].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

const decode = (text: string) => text.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
const hasPasswordInput = (html: string) => /<input\b[^>]*type\s*=\s*["']password["']/i.test(html);

/** The visible text of a Qlik answer, which carries the refusal reason. Input values never get in. */
function pageText(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 200);
}

function parseForm(html: string, pageUrl: string) {
  const form = html.match(/<form\b[^>]*>/i)?.[0] ?? "";
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)]
    .map(([tag]) => ({
      name: attr(tag, "name"),
      type: (attr(tag, "type") ?? "text").toLowerCase(),
      value: decode(attr(tag, "value") ?? ""),
    }))
    .filter((input): input is { name: string; type: string; value: string } => Boolean(input.name));
  return {
    url: new URL(decode(attr(form, "action") ?? ""), pageUrl).href,
    user: inputs.find((input) => input.type === "text" || input.type === "email")?.name ?? "username",
    pwd: inputs.find((input) => input.type === "password")?.name ?? "pwd",
    hidden: inputs.filter((input) => input.type === "hidden"),
  };
}

export class Session {
  #loggingIn: Promise<void> | null = null;
  #jar: CookieJar | null = null;
  /** Sign-in steps without secrets or parameter values, for the setup check. */
  trace: string[] = [];

  constructor(
    readonly config: QlikConfig,
    private readonly credentials: Credentials,
    private readonly guard: SignInGuard,
  ) {}

  get usesForms(): boolean {
    return this.config.engineUrl === null;
  }

  get hasSession(): boolean {
    return !this.usesForms || this.#jar !== null;
  }

  headers(): Record<string, string> {
    if (!this.usesForms) return {};
    const cookie = this.#jar?.header();
    return cookie ? { cookie } : {};
  }

  async ensure(): Promise<void> {
    if (!this.usesForms || this.#jar) return;
    const blocked = this.guard.blockedReason();
    if (blocked) {
      throw new AuthError(
        `${blocked} Not signing in again so the domain does not lock the account: update the password in the Qlik Sense panel.`,
      );
    }
    // Several apps at once share one sign-in.
    this.#loggingIn ??= this.login().finally(() => (this.#loggingIn = null));
    await this.#loggingIn;
  }

  invalidate(): void {
    this.#jar = null;
  }

  /** GET/POST that follows redirects by hand to pick up the cookie of every hop. */
  async #go(jar: CookieJar, startUrl: string, init: RequestInit = {}): Promise<{ response: Response; url: string }> {
    let url = startUrl;
    let request = init;
    for (let hop = 0; hop < 10; hop++) {
      const headers: Record<string, string> = { ...(request.headers as Record<string, string> | undefined) };
      const cookie = jar.header();
      if (cookie) headers.cookie = cookie;
      const response = await fetch(url, { ...request, headers, redirect: "manual" });
      jar.absorb(response);
      const parsed = new URL(url);
      const params = [...parsed.searchParams.keys()].join("&"); // names only, never values
      this.trace.push(`${request.method ?? "GET"} ${parsed.pathname}${params ? `?${params}` : ""} → ${response.status}`);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) return { response, url };
      await response.body?.cancel();
      url = new URL(location, url).href;
      request = {};
    }
    throw new AuthError("Too many redirects while signing in to Qlik");
  }

  async login(): Promise<void> {
    if (!this.config.base || !this.config.user) throw new AuthError("Qlik Sense is not set up on this machine");
    this.trace = [];
    const jar = new CookieJar();
    let { response, url } = await this.#go(jar, new URL("hub/", this.config.base).href);
    let html = await response.text();

    if (!hasPasswordInput(html) && !url.includes("internal_forms_authentication")) {
      if (response.ok) {
        // The proxy let us in without a form (for example Windows authentication).
        this.#jar = jar;
        return;
      }
      throw new AuthError(`Qlik did not show a sign-in form: HTTP ${response.status} on ${new URL(url).pathname}`);
    }

    const form = parseForm(html, url);
    // Without targetId the proxy does not know where to return and answers 400.
    const postUrl = new URL(form.url);
    for (const [key, value] of new URL(url).searchParams) if (!postUrl.searchParams.has(key)) postUrl.searchParams.set(key, value);
    this.trace.push(`form: fields ${form.user}, ${form.pwd}${form.hidden.length ? ` + ${form.hidden.length} hidden` : ""}`);
    const body = new URLSearchParams(form.hidden.map((input) => [input.name, input.value]));
    body.set(form.user, this.config.user);
    body.set(form.pwd, await this.credentials.password());
    ({ response, url } = await this.#go(jar, postUrl.href, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }));
    html = await response.text();

    if (url.includes("internal_forms_authentication") || hasPasswordInput(html) || response.status >= 400) {
      const reason = pageText(html);
      const message =
        response.status === 400
          ? `Qlik rejected the sign-in request (HTTP 400${reason ? `: ${reason}` : ""}).`
          : `Qlik did not accept the login or password (HTTP ${response.status}${reason ? `: ${reason}` : ""}).`;
      await this.guard.block(message);
      throw new AuthError(message);
    }
    this.#jar = jar;
  }
}

/** Qlik forms expect `DOMAIN\user`; a missing backslash is the classic shell-quoting accident. */
export function checkLogin(user: string): string {
  const trimmed = user.trim();
  if (!trimmed.includes("\\")) {
    throw new Error(`Login "${trimmed}" has no domain: Qlik expects DOMAIN\\user`);
  }
  return trimmed;
}
