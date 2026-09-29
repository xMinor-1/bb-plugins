// src/http-routes.ts — the three byte-transfer routes (§5).
//
// Route matching in the host is exact `method + path` string equality, so both
// paths are derived from the contract constants the panel builds its URLs
// from: they cannot drift apart.
//
// Two host behaviours shape everything here:
//
//  * `auth: "local"` rejects any non-GET whose content-type is not exactly
//    application/json with **415** (§1.1). The upload route therefore uses
//    `auth: "token"`, the sanctioned first-party pattern for raw bodies. The
//    download route is a GET, so it keeps the default local auth and works
//    from a plain `<a download>` navigation.
//  * The global `compress()` middleware also runs for plugin routes and does
//    not skip 206 in hono 4.11. `Content-Type: application/octet-stream` is
//    outside its compressible set, so declaring it (plus `no-transform`) is
//    what keeps `Content-Length` alive on a multi-GB download.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, HTTP_BASE, UPLOAD_CHUNK_URL } from "../contract";
import { isFileManagerError, mapNodeError } from "./errors";
import { getRoot, resolveExisting } from "./root";
import type { UploadsModule } from "./uploads";
import { collectZipItems, zipLength, zipStream, type ZipItem } from "./zip-stream";

/** `/upload/chunk`, `/download`, `/download-zip` — the tails of the contract's URLs. */
export const UPLOAD_CHUNK_ROUTE = UPLOAD_CHUNK_URL.slice(HTTP_BASE.length);
export const DOWNLOAD_ROUTE = DOWNLOAD_URL.slice(HTTP_BASE.length);
export const DOWNLOAD_ZIP_ROUTE = DOWNLOAD_ZIP_URL.slice(HTTP_BASE.length);

export interface HttpRoutesOptions {
  uploads: Pick<UploadsModule, "writeChunk">;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      // Explicit, because a plugin route inherits nothing.
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

/** RFC 6266: an ASCII-safe `filename=` plus the real name in `filename*`. */
export function contentDisposition(fileName: string, disposition: "attachment" | "inline"): string {
  const ascii = [...fileName]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      // Control characters would be header injection; `"` and `\` would break
      // (or be re-interpreted inside) the quoted-string.
      return code >= 0x20 && code <= 0x7e && character !== '"' && character !== "\\";
    })
    .join("")
    .trim();
  const fallback = ascii === "" ? "download" : ascii;
  const encoded = encodeURIComponent(fileName).replaceAll("'", "%27");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range` header against a known size.
 *
 * - `null`   → no (or unusable) range: serve 200 with the whole body. Multi
 *   ranges land here too, which is the legal degradation §5.3 asks for.
 * - `"unsatisfiable"` → 416 plus `Content-Range: bytes * /<size>`.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  if (header === undefined) return null;
  const match = /^bytes=(.+)$/iu.exec(header.trim());
  if (!match) return null;
  const spec = (match[1] ?? "").trim();
  if (spec.includes(",")) return null; // multi-range: answer 200 with everything
  const parts = /^(\d*)-(\d*)$/u.exec(spec);
  if (!parts) return null;
  const rawStart = parts[1] ?? "";
  const rawEnd = parts[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return "unsatisfiable";
  if (rawEnd === "") return { start, end: size - 1 };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

/** `"<size in hex>-<floor(mtimeMs) in hex>"`, quoted, as §5.3 spells it out. */
export function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/** not_found → 404, path_escape → 403, everything else → 500. */
function statusForResolveError(error: unknown): number {
  const mapped = isFileManagerError(error) ? error : mapNodeError(error);
  if (mapped.code === "path_escape") return 403;
  if (mapped.code === "not_found" || mapped.code === "not_a_directory") return 404;
  if (mapped.code === "permission_denied") return 403;
  if (mapped.code === "invalid_path" || mapped.code === "invalid_name") return 400;
  if (mapped.code === "unsupported") return 413;
  return 500;
}

/**
 * The archive's file name: a lone folder names it after itself, anything else
 * after the folder the selection sits in.
 */
export function zipFileName(dir: string, names: readonly string[]): string {
  const single = names.length === 1 ? names[0] : undefined;
  const base = single === undefined ? path.basename(dir) : path.posix.basename(single);
  return `${base === "" ? path.basename(getRoot()) : base}.zip`;
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerHttpRoutes(bb: BbPluginApi, options: HttpRoutesOptions): void {
  /* ---- Route 1: POST /http/upload/chunk (auth: token, raw body) ---- */
  bb.http.route(
    "POST",
    UPLOAD_CHUNK_ROUTE,
    async (context: Context) => {
      // Everything below the call is raw node:fs — no bb.* handle is touched
      // while bytes are moving (§5.2).
      const outcome = await options.uploads.writeChunk({
        uploadId: context.req.query("uploadId"),
        offset: context.req.query("offset"),
        body: context.req.raw.body,
        signal: context.req.raw.signal,
      });
      // Hand-built because 499 is outside hono's StatusCode union.
      return jsonResponse(outcome.status, outcome.body);
    },
    { auth: "token" },
  );

  /* ---- Route 2: GET /http/download (auth: local, the default) ---- */
  bb.http.route("GET", DOWNLOAD_ROUTE, async (context: Context) => {
    const requested = context.req.query("path");
    if (typeof requested !== "string" || requested.trim() === "") {
      return jsonResponse(400, { ok: false, error: "invalid_params" });
    }

    let absolutePath: string;
    try {
      absolutePath = await resolveExisting(requested);
    } catch (error) {
      const status = statusForResolveError(error);
      return jsonResponse(status, {
        ok: false,
        error: status === 403 ? "path_escape" : status === 404 ? "not_found" : "io_error",
      });
    }

    let size: number;
    let mtimeMs: number;
    let mtime: Date;
    try {
      const st = await stat(absolutePath);
      // §5.3: directories are not downloadable in v0.1.
      if (!st.isFile()) return jsonResponse(404, { ok: false, error: "not_a_file" });
      size = st.size;
      mtimeMs = st.mtimeMs;
      mtime = st.mtime;
    } catch (error) {
      return jsonResponse(statusForResolveError(error), { ok: false, error: "not_found" });
    }

    const disposition = context.req.query("disposition") === "inline" ? "inline" : "attachment";
    const headers = new Headers({
      // Mandatory: keeps compress() away, which keeps Content-Length alive.
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store, no-transform",
      ETag: etagFor(size, mtimeMs),
      "Last-Modified": mtime.toUTCString(),
      "Content-Disposition": contentDisposition(path.basename(absolutePath), disposition),
      "X-Content-Type-Options": "nosniff",
    });

    const range = parseRange(context.req.header("range"), size);
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }

    const start = range === null ? 0 : range.start;
    const end = range === null ? Math.max(0, size - 1) : range.end;
    const length = size === 0 ? 0 : end - start + 1;
    headers.set("Content-Length", String(length));
    if (range !== null) {
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    }

    if (length === 0) {
      return new Response(null, { status: range === null ? 200 : 206, headers });
    }

    // The only thing held across the response is a raw fd: a `bb plugin
    // reload` mid-download disposes plugin resources, not this (§14 risk 6).
    const stream = createReadStream(absolutePath, { start, end });
    const abort = (): void => {
      stream.destroy();
    };
    context.req.raw.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => {
      context.req.raw.signal.removeEventListener("abort", abort);
    });

    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: range === null ? 200 : 206,
      headers,
    });
  });

  /* ---- Route 3: GET /http/download-zip (auth: local, the default) ---- */
  // A GET for the same reason as route 2: an `<a download>` click streams it
  // straight to disk. Everything is walked and stat'ed before the first byte,
  // so a bad name answers with a status instead of a half-written archive.
  bb.http.route("GET", DOWNLOAD_ZIP_ROUTE, async (context: Context) => {
    const dir = context.req.query("dir");
    const names = context.req.queries("name") ?? [];
    if (typeof dir !== "string" || dir.trim() === "" || names.length === 0) {
      return jsonResponse(400, { ok: false, error: "invalid_params" });
    }

    let items: ZipItem[];
    try {
      items = await collectZipItems(dir, names);
    } catch (error) {
      const status = statusForResolveError(error);
      const mapped = isFileManagerError(error) ? error : mapNodeError(error);
      return jsonResponse(status, { ok: false, error: mapped.code });
    }
    if (items.length === 0) return jsonResponse(404, { ok: false, error: "not_a_file" });

    const stream = Readable.from(zipStream(items));
    const abort = (): void => {
      stream.destroy();
    };
    context.req.raw.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => {
      context.req.raw.signal.removeEventListener("abort", abort);
    });
    stream.once("error", (error) => {
      bb.log.warn(`zip download failed: ${String(error)}`);
    });

    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        // Outside compress()'s set, like route 2, so Content-Length survives.
        "Content-Type": "application/zip",
        "Content-Length": String(zipLength(items)),
        "Cache-Control": "no-store, no-transform",
        "Content-Disposition": contentDisposition(zipFileName(dir, names), "attachment"),
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  bb.log.info(
    `http routes ready — POST ${HTTP_BASE}${UPLOAD_CHUNK_ROUTE} (token), GET ${HTTP_BASE}${DOWNLOAD_ROUTE}` +
      ` and ${HTTP_BASE}${DOWNLOAD_ZIP_ROUTE} (local)`,
  );
}
