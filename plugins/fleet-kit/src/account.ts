// The build's shared sign-in: one login and password the person types once on
// the First run page, kept in the credential store, handed to each plugin of
// the step in the form that plugin wants.
//
// Every plugin of the step answers the RPC method `accountSignIn`
//   input  { user: string, password: string, lang?: "en" | "ru" }
//   output { state: "done" | "todo" | "problem", summary: string, path?: string, rejected?: boolean }
// and lets Fleet Kit call it once its `accountPlugins` setting names Fleet Kit.
// `rejected`: the service refused this login or password. Fleet Kit then does
// not send the same pair to that plugin again until the person types a new
// one: a directory locks an account after a few wrong passwords.
//
// A plugin that is already signed in (its `setupStatus` says done, such as
// mail through the computer's own Kerberos sign-in) gets nothing.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AccountBlock } from "./manifest.js";
import type { PluginAnswer } from "./setup.js";

export const ACCOUNT_METHOD = "accountSignIn";
/** A plugin's sign-in checks against its service; give it time. */
export const ACCOUNT_CALL_MS = 60_000;
/** A try that failed for another reason (the network, the plugin) is repeated on later syncs, this many times in all. */
export const ACCOUNT_TRIES = 3;

export const accountAnswerSchema = z.object({
  state: z.enum(["done", "todo", "problem"]),
  summary: z.string().max(300),
  path: z.string().max(300).optional(),
  rejected: z.boolean().optional(),
});

/** The name of the step's login and password in the credential store. */
export const accountSecretName = (stepId: string) => `account-${stepId}`;

export interface AccountValue {
  login: string;
  password: string;
}

/** The login without a domain: "DOMAIN\name", "name@domain" and "name" all give "name". */
export function bareLogin(typed: string): string {
  let login = typed.trim();
  const slash = login.lastIndexOf("\\");
  if (slash >= 0) login = login.slice(slash + 1);
  const at = login.indexOf("@");
  if (at >= 0) login = login.slice(0, at);
  return login.trim();
}

/** The login in the form one plugin wants: the template with `{login}` filled in. */
export function loginFor(template: string, typed: string): string {
  return template.split("{login}").join(bareLogin(typed));
}

export function checkAccount(login: string, password: string): AccountValue {
  const bare = bareLogin(login);
  if (bare === "" || /[\s:]/.test(bare) || /[\u0000-\u001f\u007f]/.test(login)) {
    throw new Error("The login is empty or has spaces, a colon or control characters.");
  }
  if (password === "" || /[\u0000-\u001f\u007f]/.test(password)) throw new Error("The password is empty or has control characters.");
  if (login.length > 256 || password.length > 1024) throw new Error("The login or password is too long.");
  return { login: login.trim(), password };
}

/** Which pair a result belongs to: a new password starts over. Not a secret: a short hash of both. */
export function accountVersion(value: AccountValue): string {
  return createHash("sha256").update(`${value.login}\n${value.password}`).digest("hex").slice(0, 16);
}

/** What one plugin made of the shared sign-in. */
export interface AccountResult {
  version: string;
  state: "done" | "todo" | "problem";
  summary: string | null;
  /** Fleet Kit's own reason, said by the page in the person's language. */
  reason?: "old-version" | "not-allowed" | "no-answer" | undefined;
  rejected: boolean;
  tries: number;
  at: string;
}

export type AccountResults = Record<string, AccountResult>;

export interface HandOutDeps {
  block: AccountBlock;
  value: AccountValue;
  results: AccountResults;
  /** The plugins on this bb now; one not installed or off gets the sign-in once it is. */
  installed: Map<string, { enabled: boolean }>;
  /** Plugins this machine does not get (turned off in the person's choice). */
  wanted: (pluginId: string) => boolean;
  status: (pluginId: string) => Promise<PluginAnswer | null>;
  signIn: (pluginId: string, user: string, password: string, lang: "en" | "ru") => Promise<z.infer<typeof accountAnswerSchema>>;
  lang: "en" | "ru";
  now?: () => number;
}

/** Whether this plugin still needs the pair: never refused, not done, and not out of tries. */
export function needsSignIn(result: AccountResult | undefined, version: string): boolean {
  if (result === undefined || result.version !== version) return true;
  if (result.rejected) return false;
  if (result.state !== "problem") return false;
  return result.tries < ACCOUNT_TRIES;
}

/**
 * Hand the pair to every plugin of the step that is here and still needs it.
 * Returns the updated results; plugins not installed yet wait for a later call.
 */
export async function handOut(deps: HandOutDeps): Promise<{ results: AccountResults; changed: boolean }> {
  const version = accountVersion(deps.value);
  const results: AccountResults = { ...deps.results };
  const now = deps.now ?? Date.now;
  let changed = false;
  for (const entry of deps.block.plugins) {
    if (entry.enabled === false || !deps.wanted(entry.plugin)) continue;
    const installed = deps.installed.get(entry.plugin);
    if (installed === undefined || !installed.enabled) continue;
    const previous = results[entry.plugin];
    if (!needsSignIn(previous, version)) continue;
    const tries = previous?.version === version ? previous.tries + 1 : 1;
    const at = new Date(now()).toISOString();
    const status = await deps.status(entry.plugin).catch(() => null);
    if (status?.kind === "answer" && status.state === "done") {
      results[entry.plugin] = { version, state: "done", summary: status.summary, rejected: false, tries, at };
      changed = true;
      continue;
    }
    try {
      const answer = await deps.signIn(entry.plugin, loginFor(entry.login, deps.value.login), deps.value.password, deps.lang);
      results[entry.plugin] = { version, state: answer.state, summary: answer.summary.trim() || null, rejected: answer.rejected === true, tries, at };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const reason = code === "unknown_method" ? "old-version" : code === "forbidden" ? "not-allowed" : "no-answer";
      // A plugin that cannot take it now is not asked again for this pair.
      const final = reason !== "no-answer";
      results[entry.plugin] = { version, state: "problem", summary: null, reason, rejected: false, tries: final ? ACCOUNT_TRIES : tries, at };
    }
    changed = true;
  }
  return { results, changed };
}
