// Is an MCP server answering, and does it accept its token? One Streamable
// HTTP session: `initialize`, `notifications/initialized`, `tools/list`, then
// the session is closed. A 401 or 403 means the token was not accepted;
// anything else that is not a valid answer means the server is not answering.
//
// Redirects are never followed: the request carries the token, and a 3xx
// would send it to another address. Error details are short technical words
// ("HTTP 502", "timeout") and never include headers or bodies.
import type { HealthStatus } from "../../contract.js";

export const PROBE_TIMEOUT_MS = 10_000;
const MAX_BODY = 512 * 1024;
const PROTOCOL = "2025-06-18";
const CLIENT = { name: "bb-mcp-catalog", version: "0.1.0" };

export interface ProbeResult {
  status: Exclude<HealthStatus, "unknown">;
  detail: string | null;
  tools: number | null;
}

class ProbeFailure extends Error {
  constructor(
    readonly status: "down" | "unauthorized",
    detail: string,
  ) {
    super(detail);
  }
}

/** Read at most MAX_BODY bytes of a response. */
async function readBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new ProbeFailure("down", "answer too large");
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The JSON-RPC answer with `id` from a JSON body or an SSE stream. A stream is
 * read only until that answer arrives: servers may keep it open.
 */
async function answerFor(response: Response, id: number): Promise<Record<string, unknown>> {
  const type = response.headers.get("content-type") ?? "";
  if (/text\/event-stream/i.test(type)) {
    if (!response.body) throw new ProbeFailure("down", "empty answer");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) throw new ProbeFailure("down", "answer too large");
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data === "") continue;
          const message = parseJson(data);
          if (message && message.id === id) return message;
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
    throw new ProbeFailure("down", "no answer in the event stream");
  }
  const message = parseJson(await readBody(response));
  if (message === null) throw new ProbeFailure("down", "not an MCP answer");
  if (Array.isArray(message)) {
    const found = (message as unknown[]).find((item) => item !== null && typeof item === "object" && (item as Record<string, unknown>).id === id);
    if (found) return found as Record<string, unknown>;
    throw new ProbeFailure("down", "not an MCP answer");
  }
  return message;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function networkDetail(error: unknown, timedOut: boolean): string {
  if (timedOut) return "timeout";
  const cause = (error as { cause?: { code?: string } })?.cause ?? (error as { code?: string });
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "address not found";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "connection reset";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (/CERT|SSL|TLS/i.test(code)) return "certificate not trusted";
  return code ? code.toLowerCase() : "no connection";
}

function checkHttp(response: Response): void {
  if (response.status === 401 || response.status === 403) throw new ProbeFailure("unauthorized", `HTTP ${response.status}`);
  if (response.status >= 300 && response.status < 400) throw new ProbeFailure("down", `redirect (HTTP ${response.status})`);
  if (!response.ok) throw new ProbeFailure("down", `HTTP ${response.status}`);
}

/** A JSON-RPC error that says the credentials were refused. */
function rpcError(message: Record<string, unknown>): ProbeFailure | null {
  const error = message.error as { code?: unknown; message?: unknown } | undefined;
  if (!error || typeof error !== "object") return null;
  const text = typeof error.message === "string" ? error.message : "";
  const unauthorized = /unauthori[sz]ed|forbidden|invalid token|token (?:is )?(?:expired|invalid)|authenticat/i.test(text);
  return new ProbeFailure(unauthorized ? "unauthorized" : "down", `MCP error ${typeof error.code === "number" ? error.code : ""}`.trim());
}

export async function probeServer(
  url: string,
  headers: Record<string, string>,
  options: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ProbeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let session: string | null = null;
  let protocol = PROTOCOL;
  const base = { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = (body: unknown) =>
    doFetch(url, {
      method: "POST",
      headers: { ...base, ...(session ? { "mcp-session-id": session } : {}), ...(session ? { "mcp-protocol-version": protocol } : {}) },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
  try {
    const first = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
    checkHttp(first);
    session = first.headers.get("mcp-session-id");
    const init = await answerFor(first, 1);
    const initError = rpcError(init);
    if (initError) throw initError;
    const result = init.result as { protocolVersion?: unknown } | undefined;
    if (!result || typeof result !== "object") throw new ProbeFailure("down", "not an MCP answer");
    if (typeof result.protocolVersion === "string" && /^[\w.-]{1,32}$/.test(result.protocolVersion)) protocol = result.protocolVersion;

    let tools: number | null = null;
    try {
      const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      await notified.body?.cancel().catch(() => undefined);
      const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      checkHttp(listed);
      const list = await answerFor(listed, 2);
      const listError = rpcError(list);
      if (listError?.status === "unauthorized") throw listError;
      const found = (list.result as { tools?: unknown } | undefined)?.tools;
      if (Array.isArray(found)) tools = found.length;
    } catch (error) {
      // The handshake worked; a refused token on the next call still counts.
      if (error instanceof ProbeFailure && error.status === "unauthorized") throw error;
    }
    return { status: "ok", detail: null, tools };
  } catch (error) {
    if (error instanceof ProbeFailure) return { status: error.status, detail: error.message, tools: null };
    return { status: "down", detail: networkDetail(error, timeout.aborted), tools: null };
  } finally {
    if (session) {
      // Close the session politely; its outcome does not matter.
      doFetch(url, {
        method: "DELETE",
        headers: { ...headers, "mcp-session-id": session, "mcp-protocol-version": protocol },
        redirect: "manual",
        signal: AbortSignal.timeout(3_000),
      }).then(
        (response) => response.body?.cancel().catch(() => undefined),
        () => undefined,
      );
    }
  }
}
