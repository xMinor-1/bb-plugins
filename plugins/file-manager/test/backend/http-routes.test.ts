// test/backend/http-routes.test.ts — §11.1's http row, driven through the fake
// host's real Hono dispatch (`harness.fetchHttp`).
//
// The auth assertions matter more than they look: the fake host records auth
// modes but does not enforce them, so a regression from `token` back to the
// default `local` would pass every functional test here and then 415 in
// production on the very first chunk (§1.1).
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DOWNLOAD_URL, HTTP_BASE, UPLOAD_CHUNK_URL } from "../../contract";
import {
  DOWNLOAD_ROUTE,
  UPLOAD_CHUNK_ROUTE,
  contentDisposition,
  etagFor,
  parseRange,
  registerHttpRoutes,
} from "../../src/http-routes";
import { initRoot } from "../../src/root";
import { createUploads, type UploadsModule } from "../../src/uploads";

let root: string;
let host: ReturnType<typeof createFakePluginHost>;
let uploads: UploadsModule;

/** `/download?path=…`, with the path encoded the way the panel encodes it. */
function downloadUrl(target: string, extra = ""): string {
  return `${DOWNLOAD_ROUTE}?path=${encodeURIComponent(target)}${extra}`;
}

async function fetchDownload(url: string, init?: RequestInit): Promise<Response> {
  return host.harness.behavior.fetchHttp("GET", url, init);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-http-")));
  await initRoot(root);
  host = createFakePluginHost({ pluginId: "file-manager" });
  uploads = await createUploads(host.bb, { settings: { chunkSizeBytes: () => 4 * 1024 * 1024 } });
  registerHttpRoutes(host.bb, { uploads });
});

afterEach(async () => {
  await host.harness.lifecycle.dispose();
});

describe("registration", () => {
  it("registers exactly the two §5 routes, with the upload route on token auth", () => {
    const routes = host.harness.inspection.registrations.httpRoutes.map((route) => ({
      method: route.method,
      path: route.path,
      auth: route.auth,
    }));

    expect(routes).toContainEqual({ method: "POST", path: "/upload/chunk", auth: "token" });
    expect(routes).toContainEqual({ method: "GET", path: "/download", auth: "local" });
    expect(routes).toHaveLength(2);
  });

  it("derives both paths from the URLs the panel builds", () => {
    expect(`${HTTP_BASE}${UPLOAD_CHUNK_ROUTE}`).toBe(UPLOAD_CHUNK_URL);
    expect(`${HTTP_BASE}${DOWNLOAD_ROUTE}`).toBe(DOWNLOAD_URL);
  });
});

describe("POST /upload/chunk", () => {
  it("streams chunks in and reports the durable byte count", async () => {
    const payload = randomBytes(2048);
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "over-http.bin",
      sizeBytes: payload.length,
      lastModifiedMs: 0,
      relativeDir: "",
    });

    for (const [offset, slice] of [
      [0, payload.subarray(0, 1000)],
      [1000, payload.subarray(1000)],
    ] as const) {
      const response = await host.harness.behavior.fetchHttp(
        "POST",
        `${UPLOAD_CHUNK_ROUTE}?uploadId=${created.uploadId}&offset=${offset}`,
        {
          method: "POST",
          body: new Uint8Array(slice),
          headers: { "content-type": "application/octet-stream" },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        uploadId: created.uploadId,
        received: offset + slice.length,
      });
    }

    await uploads.uploadFinish({ uploadId: created.uploadId, conflict: "fail" });
    expect(await readFile(path.join(root, "over-http.bin"))).toEqual(payload);
  });

  it("maps every §5.2 failure onto its status code", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "codes.bin",
      sizeBytes: 4,
      lastModifiedMs: 0,
      relativeDir: "",
    });

    const badParams = await host.harness.behavior.fetchHttp(
      "POST",
      `${UPLOAD_CHUNK_ROUTE}?uploadId=zzz&offset=0`,
      { method: "POST", body: new Uint8Array([1]) },
    );
    expect(badParams.status).toBe(400);
    expect(await badParams.json()).toEqual({ ok: false, error: "invalid_params" });

    const unknown = await host.harness.behavior.fetchHttp(
      "POST",
      `${UPLOAD_CHUNK_ROUTE}?uploadId=${"c".repeat(32)}&offset=0`,
      { method: "POST", body: new Uint8Array([1]) },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ ok: false, error: "upload_not_found" });

    const wrongOffset = await host.harness.behavior.fetchHttp(
      "POST",
      `${UPLOAD_CHUNK_ROUTE}?uploadId=${created.uploadId}&offset=2`,
      { method: "POST", body: new Uint8Array([1, 2]) },
    );
    expect(wrongOffset.status).toBe(409);
    expect(await wrongOffset.json()).toEqual({
      ok: false,
      error: "offset_mismatch",
      expected: 0,
    });

    const tooBig = await host.harness.behavior.fetchHttp(
      "POST",
      `${UPLOAD_CHUNK_ROUTE}?uploadId=${created.uploadId}&offset=0`,
      { method: "POST", body: new Uint8Array([1, 2, 3, 4, 5, 6]) },
    );
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ ok: false, error: "size_mismatch" });
  });

  it("answers JSON with no-store on the success path", async () => {
    const created = await uploads.uploadCreate({
      dirPath: root,
      fileName: "headers.bin",
      sizeBytes: 1,
      lastModifiedMs: 0,
      relativeDir: "",
    });
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      `${UPLOAD_CHUNK_ROUTE}?uploadId=${created.uploadId}&offset=0`,
      { method: "POST", body: new Uint8Array([7]) },
    );
    expect(response.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /download", () => {
  const CYRILLIC = "отчёт «квартал».bin";

  beforeEach(async () => {
    await writeFile(path.join(root, "sample.bin"), "0123456789");
    await mkdir(path.join(root, "folder"), { recursive: true });
  });

  it("streams the exact bytes with every mandatory header", async () => {
    const target = path.join(root, "sample.bin");
    const st = await stat(target);
    const response = await fetchDownload(downloadUrl(target));

    expect(response.status).toBe(200);
    // Mandatory: octet-stream is what keeps hono's compress() away, which is
    // what keeps Content-Length alive on a multi-GB download.
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("etag")).toBe(etagFor(st.size, st.mtimeMs));
    expect(response.headers.get("last-modified")).toBe(st.mtime.toUTCString());
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="sample.bin"; filename*=UTF-8''sample.bin`,
    );
    expect(await response.text()).toBe("0123456789");
  });

  it("encodes a non-ASCII name in filename* and keeps an ASCII fallback", async () => {
    const target = path.join(root, CYRILLIC);
    await writeFile(target, "x");
    const response = await fetchDownload(downloadUrl(target));

    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toBe(contentDisposition(CYRILLIC, "attachment"));
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(CYRILLIC)}`);
    // The ASCII fallback keeps only printable ASCII, and never a bare quote.
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]*"; /u);
    expect(disposition).toContain('filename=".bin"');
  });

  it("round-trips names that survive encodeURIComponent unscathed", async () => {
    // `+`, spaces and `%` are the classic query-decoding traps; a filename is
    // allowed to contain all three.
    for (const name of ["a+b.txt", "a b.txt", "100% done.bin", "a&b=c.txt"]) {
      await writeFile(path.join(root, name), name);
      const response = await fetchDownload(downloadUrl(path.join(root, name)));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(name);
    }
  });

  it("never lets a file name break out of the Content-Disposition header", async () => {
    const hostile = 'we"ird\\name\nline.bin';
    expect(contentDisposition(hostile, "attachment")).toBe(
      `attachment; filename="weirdnameline.bin"; filename*=UTF-8''${encodeURIComponent(hostile)}`,
    );
    // A name with no usable ASCII still yields a legal header.
    expect(contentDisposition("Ω.bin", "attachment")).toContain('filename=".bin"');
    expect(contentDisposition("Ω", "attachment")).toContain('filename="download"');
  });

  it("honours disposition=inline", async () => {
    const response = await fetchDownload(downloadUrl(path.join(root, "sample.bin"), "&disposition=inline"));
    expect(response.headers.get("content-disposition")).toMatch(/^inline; /u);
  });

  it("answers 206 with Content-Range for a byte range", async () => {
    const response = await fetchDownload(downloadUrl(path.join(root, "sample.bin")), {
      headers: { Range: "bytes=2-5" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("2345");
  });

  it("supports an open-ended range and a suffix range", async () => {
    const openEnded = await fetchDownload(downloadUrl(path.join(root, "sample.bin")), {
      headers: { Range: "bytes=7-" },
    });
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await openEnded.text()).toBe("789");

    const suffix = await fetchDownload(downloadUrl(path.join(root, "sample.bin")), {
      headers: { Range: "bytes=-3" },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");
  });

  it("answers 416 with `bytes */size` for an unsatisfiable range", async () => {
    const response = await fetchDownload(downloadUrl(path.join(root, "sample.bin")), {
      headers: { Range: "bytes=999-" },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(await response.text()).toBe("");
  });

  it("degrades a multi-range request to the full 200 body", async () => {
    const response = await fetchDownload(downloadUrl(path.join(root, "sample.bin")), {
      headers: { Range: "bytes=0-1,4-5" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
  });

  it("rejects a missing path with 400, a directory with 404 and an escape with 403", async () => {
    const missingParam = await fetchDownload(DOWNLOAD_ROUTE);
    expect(missingParam.status).toBe(400);
    expect(await missingParam.json()).toEqual({ ok: false, error: "invalid_params" });

    const directory = await fetchDownload(downloadUrl(path.join(root, "folder")));
    expect(directory.status).toBe(404);

    const absent = await fetchDownload(downloadUrl(path.join(root, "nope.bin")));
    expect(absent.status).toBe(404);

    const outside = await fetchDownload(downloadUrl("/etc/passwd"));
    expect(outside.status).toBe(403);
    expect(await outside.json()).toEqual({ ok: false, error: "path_escape" });

    const traversal = await fetchDownload(downloadUrl(`${root}/../../etc/passwd`));
    expect(traversal.status).toBe(403);
  });

  it("refuses a symlink that points outside the root", async () => {
    await symlink("/etc/passwd", path.join(root, "escape-link"));
    // realpath runs before the prefix test, so the link is judged by its target.
    const response = await fetchDownload(downloadUrl(path.join(root, "escape-link")));
    expect(response.status).toBe(403);
  });

  it("serves an empty file as a 0-byte 200", async () => {
    await writeFile(path.join(root, "empty.bin"), "");
    const response = await fetchDownload(downloadUrl(path.join(root, "empty.bin")));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
  });

  it("streams a file far larger than any buffer without truncating it", async () => {
    const big = randomBytes(3 * 1024 * 1024);
    await writeFile(path.join(root, "big.bin"), big);
    const response = await fetchDownload(downloadUrl(path.join(root, "big.bin")));

    expect(response.headers.get("content-length")).toBe(String(big.length));
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received.length).toBe(big.length);
    expect(Buffer.from(received).equals(big)).toBe(true);
  });
});

describe("parseRange", () => {
  it("covers the forms §5.3 lists", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=0-99", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange("bytes=-40", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    // Malformed or multi-range: ignored, which means a legal 200.
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=abc", 10)).toBeNull();
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
  });
});
