import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_TEXT_PREVIEW_BYTES } from "../../lib/preview-limit";
import { readRemoteText } from "../../lib/remote-text";

const URL = "https://bb.test/preview/fixture/large.log";

afterEach(() => vi.unstubAllGlobals());

describe("remote text preview", () => {
  it("requests a bounded range and leaves a split UTF-8 character out of the prefix", async () => {
    const bytes = new Uint8Array(MAX_TEXT_PREVIEW_BYTES).fill(97);
    bytes[MAX_TEXT_PREVIEW_BYTES - 1] = 0xf0;
    const size = MAX_TEXT_PREVIEW_BYTES + 3;
    const fetch = vi.fn(async () => new Response(bytes, {
      status: 206,
      headers: { "Content-Range": `bytes 0-${String(bytes.length - 1)}/${String(size)}` },
    }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;

    const preview = await readRemoteText(URL, signal);
    expect(fetch).toHaveBeenCalledWith(URL, {
      headers: { Range: `bytes=0-${String(MAX_TEXT_PREVIEW_BYTES - 1)}` },
      signal,
    });
    expect(preview).toEqual({
      text: "a".repeat(MAX_TEXT_PREVIEW_BYTES - 1),
      sizeBytes: size,
      readBytes: MAX_TEXT_PREVIEW_BYTES - 1,
      truncated: true,
    });
  });

  it("shows an empty file and rejects binary data as unsupported", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 416, headers: { "Content-Range": "bytes */0" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 0, 2]), {
        status: 206, headers: { "Content-Range": "bytes 0-2/3" },
      })));
    const signal = new AbortController().signal;
    await expect(readRemoteText(URL, signal)).resolves.toEqual({ text: "", sizeBytes: 0, readBytes: 0, truncated: false });
    await expect(readRemoteText(URL, signal)).resolves.toBeNull();
  });

  it("cancels an unexpectedly large whole-file response", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "Content-Length": String(MAX_TEXT_PREVIEW_BYTES + 1) },
    })));
    await expect(readRemoteText(URL, new AbortController().signal)).rejects.toThrow("Unexpected file preview response");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
