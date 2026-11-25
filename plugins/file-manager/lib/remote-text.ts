import { MAX_TEXT_PREVIEW_BYTES } from "./preview-limit";
import type { RpcOutput } from "./fm-rpc";

type TextPreview = Omit<RpcOutput<"readTextFile">, "path">;

/** The daemon's preview route can serve a bounded prefix of a large log. */
export async function readRemoteText(url: string, signal: AbortSignal): Promise<TextPreview | null> {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${String(MAX_TEXT_PREVIEW_BYTES - 1)}` },
    signal,
  });
  const contentRange = response.headers.get("Content-Range");
  if (response.status === 416 && contentRange === "bytes */0") {
    return { text: "", sizeBytes: 0, readBytes: 0, truncated: false };
  }
  const range = contentRange?.match(/^bytes 0-\d+\/(\d+)$/u);
  const length = response.headers.get("Content-Length");
  const sizeBytes = Number(response.status === 206 ? range?.[1] : length ?? undefined);
  if (!response.ok || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 ||
      (response.status === 200 && sizeBytes > MAX_TEXT_PREVIEW_BYTES)) {
    await response.body?.cancel();
    throw new Error(`Unexpected file preview response (${String(response.status)})`);
  }

  const bytes = new Uint8Array(Math.min(sizeBytes, MAX_TEXT_PREVIEW_BYTES));
  const reader = response.body?.getReader();
  let offset = 0;
  if (reader !== undefined) {
    try {
      while (offset < bytes.length) {
        const result = await reader.read();
        if (result.done) break;
        const remaining = result.value.subarray(0, bytes.length - offset);
        bytes.set(remaining, offset);
        offset += remaining.length;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  if (offset !== bytes.length) throw new Error("Incomplete file preview response");

  const truncated = sizeBytes > offset;
  if (bytes.includes(0)) return null;
  try {
    // Leave an incomplete UTF-8 character at the end of a truncated prefix out.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, {
      stream: truncated,
    });
    return { text, sizeBytes, readBytes: new TextEncoder().encode(text).length, truncated };
  } catch {
    return null;
  }
}
