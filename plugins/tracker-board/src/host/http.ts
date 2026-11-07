// One request to the tracker with the API key in a header. Redirects are not
// followed: the key goes to the configured address and nowhere else. Nothing here
// logs a header or the key.
import type { FailureCode } from "../../contract.js";
import { LIMITS } from "../shared/limits.js";

export const REQUEST_TIMEOUT_MS = 60_000;
const DETAIL_CHARS = 300;

export type HttpResult =
  | { ok: true; status: number; text: string; truncated: boolean; headers: Record<string, string> }
  | { ok: false; code: FailureCode; status: number | null; detail: string | null };

const fail = (code: FailureCode, status: number | null = null, detail: string | null = null): HttpResult => ({ ok: false, code, status, detail });

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
  if (status === 409) return "conflict";
  if (status >= 500) return "serverError";
  return "badRequest";
}

export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body: string | null;
  exposeHeaders: readonly string[];
}

export async function httpSend(request: HttpRequest, options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const response = await fetch(request.url, {
      method: request.method,
      redirect: "manual",
      signal,
      headers: { accept: "application/json", ...(request.body !== null ? { "content-type": "application/json" } : {}), ...request.headers },
      ...(request.body !== null ? { body: request.body } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return fail("redirect", response.status);
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      return fail("unauthorized", 401);
    }
    if (!response.ok) {
      // The tracker's own wording helps the agent and the person fix a request.
      const text = await readBounded(response, DETAIL_CHARS * 4).then((body) => body.text, () => "");
      return fail(failureOfStatus(response.status), response.status, text.trim().slice(0, DETAIL_CHARS) || null);
    }
    const { text, truncated } = await readBounded(response, options.maxBytes ?? LIMITS.responseBytes);
    if (!truncated && text.trim() !== "") {
      try {
        JSON.parse(text);
      } catch {
        // A sign-in page or a proxy's answer with status 200 must not pass for data.
        return fail("notJson", response.status);
      }
    }
    const headers: Record<string, string> = {};
    for (const name of request.exposeHeaders) {
      const value = response.headers.get(name);
      if (value !== null) headers[name.toLowerCase()] = value.slice(0, 200);
    }
    return { ok: true, status: response.status, text, truncated, headers };
  } catch (error) {
    return networkFailure(error, signal);
  }
}
