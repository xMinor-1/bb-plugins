// Failures the person can act on carry a code, so the panel says them in its
// own language. Agents, the CLI and logs get the English text alone; the panel
// gets the same text behind a tag — `[mail:<code>]` or `[mail:<code>:<param>]`,
// the param URI-encoded — and shows its translation instead. A failure without
// a code reaches the panel in English, as it is.
import { TransportError } from "./curl.js";
import { AuthError, UrlError } from "./ews/client.js";
import { EwsError } from "./ews/parse.js";
import { SignInPaused } from "./signin.js";

/** Every one has a translation in the panel's src/app/errors.ts; a test holds them in step. */
export const PANEL_CODES = [
  "not-connected",
  "password-missing",
  "password-required",
  "password-other-account",
  "login-required",
  "bad-address",
  "https-required",
  "login-in-address",
  "signin-paused",
  "signin-ask",
  "auth-refused",
  "auth-negotiate",
  "unreachable",
  "broke-off",
  "timeout",
  "tls",
  "curl-missing",
  "ews-forbidden",
  "ews-not-found",
  "ews-redirect",
  "item-gone",
  "no-machine",
] as const;

export type PanelCode = (typeof PANEL_CODES)[number];

export class UserError extends Error {
  constructor(
    message: string,
    readonly code: PanelCode | null = null,
  ) {
    super(message);
  }
}

const EWS: Record<string, PanelCode> = { Forbidden: "ews-forbidden", NotFound: "ews-not-found", Redirect: "ews-redirect", ErrorItemNotFound: "item-gone" };

export function codeOf(error: unknown): { code: PanelCode; param: string | null } | null {
  if (error instanceof UserError || error instanceof UrlError || error instanceof AuthError) return error.code ? { code: error.code, param: null } : null;
  if (error instanceof SignInPaused) return { code: error.code, param: error.retryAt === null ? null : String(error.retryAt) };
  if (error instanceof TransportError) {
    if (error.code === "aborted" || error.code === "failed") return null;
    return { code: error.code, param: error.detail };
  }
  if (error instanceof EwsError) return EWS[error.code] ? { code: EWS[error.code]!, param: null } : null;
  return null;
}

/** For agents and logs: the English text. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** For the panel: the English text behind its code, when it has one. */
export function forPanel(error: unknown): string {
  const coded = codeOf(error);
  if (!coded) return describe(error);
  return `[mail:${coded.code}${coded.param ? `:${encodeURIComponent(coded.param)}` : ""}] ${describe(error)}`;
}
