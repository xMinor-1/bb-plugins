// Forwards an agent's model request: through the masking proxy when masking
// is on for the thread, straight to the upstream when it is off. With masking
// on and no proxy, the request is refused rather than sent unmasked.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { isTokenCount, KEY_HEADER, THREAD_HEADER, type FeedEntry } from "./shared";
import type { MaskMatcher, ThreadFeeds } from "./feed";

export type ProxyTarget = { url: string } | { error: string };

export interface ForwardDeps {
  /** Shared secret the agent sends; requests without it are refused. */
  key: string;
  /** Where the agent's requests go without masking. */
  upstream: string;
  isMasking(threadId: string): Promise<boolean>;
  /** The running proxy; may wait a little for one that is starting. */
  proxy(): ProxyTarget | Promise<ProxyTarget>;
  /** What the agent shows when masking is on and the proxy is not there. */
  refusedMessage?(error: string): string;
  feeds: ThreadFeeds;
  masks: MaskMatcher;
  changed(threadId: string): void;
  fetch?: typeof fetch;
  now?: () => number;
}

const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "upgrade",
  "proxy-connection",
  KEY_HEADER,
  THREAD_HEADER,
]);

const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

/** An error in the Messages API shape, so the agent shows the message. */
function apiError(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function modelOf(body: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { model?: unknown }).model === "string") {
      return (parsed as { model: string }).model;
    }
  } catch {
    // Not JSON: forward as is.
  }
  return null;
}

/** Constant-time check of the routing key: the route is reachable wherever bb is. */
function keyMatches(given: string | null, key: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function joinUrl(base: string, path: string, search: string): string {
  return `${base.replace(/\/+$/u, "")}${path}${search}`;
}

export async function forwardRequest(request: Request, path: string, deps: ForwardDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  if (!keyMatches(request.headers.get(KEY_HEADER), deps.key)) {
    return apiError(403, "This request did not come from a bb agent session routed by the Obfuscation Proxy plugin.");
  }
  const threadId = request.headers.get(THREAD_HEADER)?.trim() || "unknown";
  const body = new Uint8Array(await request.arrayBuffer());
  const search = new URL(request.url).search;
  const masking = await deps.isMasking(threadId);
  const started = now();
  const entry: FeedEntry = {
    id: randomUUID(),
    at: started,
    path,
    model: modelOf(body),
    via: masking ? "proxy" : "direct",
    status: null,
    durationMs: null,
    masked: null,
    maskedTotal: 0,
    error: null,
  };

  let target: string;
  if (masking) {
    const proxy = await deps.proxy();
    if ("error" in proxy) {
      entry.via = "blocked";
      entry.status = 503;
      entry.durationMs = 0;
      entry.error = proxy.error;
      await deps.feeds.start(threadId, entry);
      await deps.feeds.finish(threadId, entry);
      deps.changed(threadId);
      return apiError(
        503,
        deps.refusedMessage?.(proxy.error) ??
          `Masking is on for this thread, but the masking proxy is not running (${proxy.error}). ` +
            "Nothing was sent. Turn masking off above the message box to send without it.",
      );
    }
    target = joinUrl(proxy.url, path, search);
  } else {
    target = joinUrl(deps.upstream, path, search);
  }

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!DROP_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  // The proxy restores masked values only in uncompressed responses.
  headers.set("accept-encoding", "identity");

  const forget = masking
    ? deps.masks.expect(body.byteLength, (byCategory) => {
        entry.masked = byCategory;
      })
    : () => {};
  // Token counts come in bursts of dozens; the thread view only hears about their failures.
  const quiet = isTokenCount(path);
  await deps.feeds.start(threadId, entry);
  if (!quiet) deps.changed(threadId);

  const finish = async (error: string | null) => {
    forget();
    if (entry.durationMs === null) entry.durationMs = now() - started;
    if (error !== null && entry.error === null) entry.error = error;
    // masked stays null when the proxy sent no report: the feed shows "unknown", not zero.
    await deps.feeds.finish(threadId, entry);
    const failed = entry.error !== null || (entry.status !== null && entry.status >= 400);
    if (!quiet || failed) deps.changed(threadId);
  };

  let response: Response;
  try {
    response = await doFetch(target, {
      method: request.method,
      headers,
      body: body.byteLength > 0 ? body : undefined,
      redirect: "manual",
      signal: request.signal,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    entry.status = 502;
    await finish(message);
    return apiError(502, `Could not reach ${masking ? "the masking proxy" : "the model provider"}: ${message}`);
  }
  entry.status = response.status;

  const outHeaders = new Headers();
  response.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) outHeaders.set(name, value);
  });
  if (response.body === null) {
    await finish(null);
    return new Response(null, { status: response.status, headers: outHeaders });
  }
  let settled = false;
  const settle = (error: string | null) => {
    if (settled) return;
    settled = true;
    void finish(error);
  };
  const tracked = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush() {
        settle(null);
      },
    }),
  );
  const reader = tracked.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (cause) {
        settle(cause instanceof Error ? cause.message : String(cause));
        controller.error(cause);
      }
    },
    cancel(reason) {
      settle("Cancelled by the agent");
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: outHeaders });
}
