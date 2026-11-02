// One GET to the service with HTTP Basic. Redirects are not followed: the password
// goes to the configured address and nowhere else. The request never carries the
// login in its address, and nothing here logs a header.
import type { FailureCode } from "../../contract.js";

// About 80 000 tokens: more would crowd out the conversation in the model's window.
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 60_000;
const DETAIL_CHARS = 300;

export type HttpResult = { ok: true; text: string; truncated: boolean } | { ok: false; code: FailureCode; status: number | null; detail: string | null };

const fail = (code: FailureCode, status: number | null = null, detail: string | null = null): HttpResult => ({ ok: false, code, status, detail });

/** RFC 7617 with UTF-8, so a login in Cyrillic reaches the service intact. */
export function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

const TLS_CODES = /^(CERT_|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH)/;

function networkFailure(error: unknown, signal: AbortSignal): HttpResult {
  if (signal.aborted) return fail("timeout");
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (TLS_CODES.test(code)) return fail("tls", null, code);
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return fail("timeout", null, code);
  return fail("unreachable", null, code || null);
}

async function readBounded(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = limit - size;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  // TextDecoder drops the byte order mark some services put before their JSON.
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

function failureOfStatus(status: number): FailureCode {
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status >= 500) return "serverError";
  return "badRequest";
}

export async function httpGet(url: string, user: string, password: string, options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<HttpResult> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: combined,
      headers: { authorization: basicHeader(user, password), accept: "application/json" },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return fail("redirect", response.status);
    }
    // The status decides, before any body: a 401 whose body breaks off is still a refusal.
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      return fail("unauthorized", 401);
    }
    if (!response.ok) {
      // The service's own wording helps the agent fix a request.
      const text = await readBounded(response, DETAIL_CHARS * 4).then((body) => body.text, () => "");
      return fail(failureOfStatus(response.status), response.status, text.trim().slice(0, DETAIL_CHARS) || null);
    }
    const { text, truncated } = await readBounded(response, options.maxBytes ?? MAX_RESPONSE_BYTES);
    if (!truncated) {
      try {
        JSON.parse(text);
      } catch {
        // A sign-in page or a proxy's answer with status 200 must not pass for data.
        return fail("notJson", response.status);
      }
    }
    return { ok: true, text, truncated };
  } catch (error) {
    return networkFailure(error, combined);
  }
}
