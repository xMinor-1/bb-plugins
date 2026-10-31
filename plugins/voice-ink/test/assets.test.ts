// Downloads the whisper.cpp engine depends on: resumed after a dropped
// connection, checked against the configured SHA-256, the token kept away
// from storage on another origin, archives unpacked safely, old versions pruned.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { AssetError, AssetStore, extractZip, findFile } from "../src/assets";
import { parseParts } from "../src/model-parts";
import { startDownloadServer, TOKEN, TOKEN_HEADER, type DownloadServer } from "./download-server";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const header = `${TOKEN_HEADER}: ${TOKEN}`;

let server: DownloadServer | null = null;
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "voice-ink-assets-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await server?.close();
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("downloads", () => {
  it("resumes a dropped download, checks the sum, and keeps the token on its origin", async () => {
    const model = randomBytes(3 * 1024 * 1024);
    server = await startDownloadServer({ "model.bin": model }, { cutFirstAfterBytes: 1024 * 1024 });
    const store = new AssetStore(tempDir());
    const spec = { url: `${server.registry}model.bin`, sha256: sha(model) };
    const seen: number[] = [];

    const path = await store.ensureFile(spec, "speech model", {
      authHeader: header,
      onProgress: (progress) => seen.push(progress.doneBytes),
    });

    expect(path.endsWith("model.bin")).toBe(true);
    expect(sha(new Uint8Array(readFile(path)))).toBe(spec.sha256);
    expect(server.storageLog.length).toBe(2);
    expect(server.storageLog[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(server.storageLog.some((entry) => entry.leaked)).toBe(false);
    expect(Math.max(...seen)).toBe(model.length);

    // Checked once: the next start needs neither the network nor a re-hash.
    await server.close();
    server = null;
    expect(store.presentFile(spec)).toBe(path);
    expect(await store.ensureFile(spec, "speech model", { authHeader: header })).toBe(path);
  });

  it("refuses a file whose sum does not match and leaves nothing half-done", async () => {
    server = await startDownloadServer({ "model.bin": randomBytes(4096) });
    const root = tempDir();
    const store = new AssetStore(root);
    const spec = { url: `${server.registry}model.bin`, sha256: "0".repeat(64) };
    const error = await store.ensureFile(spec, "speech model", { authHeader: header }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AssetError);
    expect((error as AssetError).permanent).toBe(true);
    expect((error as Error).message).toMatch(/does not match its SHA-256/);
    expect(readdirSync(join(root, spec.sha256))).toEqual([]);
    expect(store.presentFile(spec)).toBeNull();
  });

  it("says plainly when the server wants a token", async () => {
    server = await startDownloadServer({ "model.bin": randomBytes(16) });
    const store = new AssetStore(tempDir());
    const spec = { url: `${server.registry}model.bin`, sha256: "a".repeat(64) };
    await expect(store.ensureFile(spec, "speech model", { authHeader: null })).rejects.toThrow(/HTTP 401.*authorization header/);
  });

  it("copies from a local path the same way", async () => {
    const dir = tempDir();
    const bytes = randomBytes(10_000);
    const source = join(dir, "shared-model.bin");
    writeFileSync(source, bytes);
    const store = new AssetStore(join(dir, "store"));
    const path = await store.ensureFile({ url: source, sha256: sha(bytes) }, "speech model", { authHeader: null });
    expect(sha(new Uint8Array(readFile(path)))).toBe(sha(bytes));
  });

  it("checks the settings before going anywhere", async () => {
    const store = new AssetStore(tempDir());
    await expect(store.ensureFile({ url: "", sha256: "a".repeat(64) }, "speech model", { authHeader: null })).rejects.toThrow(
      /no address/,
    );
    await expect(store.ensureFile({ url: "https://example.invalid/x", sha256: "abc" }, "speech model", { authHeader: null })).rejects.toThrow(
      /64 hexadecimal/,
    );
  });
});

describe("checks on the way", () => {
  it("fetches a resumed file once more from the start when its sum is wrong", async () => {
    const before = randomBytes(2 * 1024 * 1024);
    const after = randomBytes(2 * 1024 * 1024);
    const files: Record<string, Buffer> = { "model.bin": before };
    // The file at the address changes while the download is cut: the resumed
    // copy is half old, half new.
    server = await startDownloadServer(files, {
      cutFirstAfterBytes: 512 * 1024,
      afterCut: () => {
        files["model.bin"] = after;
      },
    });
    const store = new AssetStore(tempDir());
    const spec = { url: `${server.registry}model.bin`, sha256: sha(after) };
    const path = await store.ensureFile(spec, "speech model", { authHeader: header });
    expect(sha(new Uint8Array(readFile(path)))).toBe(spec.sha256);
    expect(server.storageLog.map((entry) => entry.range === null)).toEqual([true, false, true]);
  });

  it("goes over https only, also where it is redirected", async () => {
    const store = new AssetStore(tempDir());
    await expect(
      store.ensureFile({ url: "http://example.invalid/model.bin", sha256: "a".repeat(64) }, "speech model", { authHeader: null }),
    ).rejects.toThrow(/must be https/);
    server = await startDownloadServer({ "model.bin": randomBytes(16) }, { redirectTo: "http://example.invalid/blob/model.bin" });
    await expect(
      store.ensureFile({ url: `${server.registry}model.bin`, sha256: "a".repeat(64) }, "speech model", { authHeader: header }),
    ).rejects.toThrow(/redirected to an address that is not https/);
  });
});

describe("files in parts", () => {
  function split(bytes: Buffer, size: number): Buffer[] {
    const parts: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += size) parts.push(bytes.subarray(at, at + size));
    return parts;
  }

  it("puts a model together from parts, resuming a dropped one, and keeps only the whole", async () => {
    const model = randomBytes(5 * 1024 * 1024 + 123);
    const parts = split(model, 2 * 1024 * 1024);
    const files = Object.fromEntries(parts.map((part, index) => [`m.bin.part-${index}`, part]));
    // The cut falls on the first part: it resumes with Range like any file.
    server = await startDownloadServer(files, { cutFirstAfterBytes: 1024 * 1024 });
    const root = tempDir();
    const store = new AssetStore(root);
    const spec = {
      sha256: sha(model),
      name: "m.bin",
      parts: parts.map((part, index) => ({ url: `${server?.registry}m.bin.part-${index}`, sha256: sha(part) })),
    };
    const seen: { done: number; total: number | null }[] = [];
    const path = await store.ensureParted(spec, "speech model", {
      authHeader: header,
      onProgress: (progress) => seen.push({ done: progress.doneBytes, total: progress.totalBytes }),
    });
    expect(path.endsWith("m.bin")).toBe(true);
    expect(sha(new Uint8Array(readFile(path)))).toBe(spec.sha256);
    expect(readdirSync(join(root, spec.sha256)).sort()).toEqual([".verified", "m.bin"]);
    expect(server.storageLog.some((entry) => entry.leaked)).toBe(false);
    expect(seen.at(-1)).toEqual({ done: model.length, total: model.length });
    expect(store.presentFile({ url: "", sha256: spec.sha256 })).toBe(path);
  });

  it("continues with the next part after an interrupted run", async () => {
    const model = randomBytes(3 * 1024 * 1024);
    const parts = split(model, 1024 * 1024);
    const files: Record<string, Buffer> = { "p0": parts[0] as Buffer, "p1": parts[1] as Buffer };
    server = await startDownloadServer(files);
    const store = new AssetStore(tempDir());
    const spec = {
      sha256: sha(model),
      name: "m.bin",
      parts: parts.map((part, index) => ({ url: `${server?.registry}p${index}`, sha256: sha(part) })),
    };
    await expect(store.ensureParted(spec, "speech model", { authHeader: header })).rejects.toThrow(/part 3 of 3 was not found/);
    files.p2 = parts[2] as Buffer;
    const path = await store.ensureParted(spec, "speech model", { authHeader: header });
    expect(sha(new Uint8Array(readFile(path)))).toBe(spec.sha256);
    // Parts one and two were fetched once.
    expect(server.storageLog.map((entry) => entry.name)).toEqual(["p0", "p1", "p2", "p2"]);
  });

  it("refuses parts that do not make the whole", async () => {
    const parts = [randomBytes(1000), randomBytes(1000)];
    server = await startDownloadServer({ a: parts[0] as Buffer, b: parts[1] as Buffer });
    const root = tempDir();
    const store = new AssetStore(root);
    const spec = {
      sha256: "0".repeat(64),
      name: "m.bin",
      parts: [
        { url: `${server.registry}a`, sha256: sha(parts[0] as Buffer) },
        { url: `${server.registry}b`, sha256: sha(parts[1] as Buffer) },
      ],
    };
    const error = await store.ensureParted(spec, "speech model", { authHeader: header }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AssetError);
    expect((error as AssetError).permanent).toBe(true);
    expect((error as Error).message).toMatch(/put together from its parts does not match/);
    expect(readdirSync(join(root, spec.sha256))).toEqual([]);
  });

  it("reads the parts setting in either order, and keeps a part without a sum to name it", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    expect(parseParts(`https://x/m.part-aa ${a}\n${b}  https://x/m.part-ab`)).toEqual([
      { url: "https://x/m.part-aa", sha256: a },
      { url: "https://x/m.part-ab", sha256: "b".repeat(64) },
    ]);
    expect(parseParts("https://x/1, https://x/2 " + a)).toEqual([
      { url: "https://x/1", sha256: "" },
      { url: "https://x/2", sha256: a },
    ]);
    expect(parseParts("  \n ")).toEqual([]);
  });
});

describe("archives", () => {
  it("unpacks an archive and finds the program in it", async () => {
    const archive = Buffer.from(
      zipSync({ "build/whisper-server": new TextEncoder().encode("#!/bin/sh\n"), "build/LICENSE.txt": new Uint8Array([1]) }),
    );
    server = await startDownloadServer({ "engine.zip": archive });
    const store = new AssetStore(tempDir());
    const spec = { url: `${server.registry}engine.zip`, sha256: sha(archive) };
    const dir = await store.ensureArchive(spec, "speech engine", { authHeader: header });
    expect(findFile(dir, "whisper-server")).toBe(join(dir, "build", "whisper-server"));
    expect(store.presentArchive(spec)).toBe(dir);
    expect(existsSync(join(dir, "..", "archive.zip"))).toBe(false);
  });

  it("refuses entries that would land outside the target", async () => {
    const evil = zipSync({ "../outside.txt": new Uint8Array([1]) });
    const dir = tempDir();
    await expect(extractZip(evil, join(dir, "x"))).rejects.toThrow(/unsafe path/);
    expect(existsSync(join(dir, "outside.txt"))).toBe(false);
  });

  it("prunes old versions it made, and nothing else", async () => {
    const root = tempDir();
    const keep = "a".repeat(64);
    const old = "b".repeat(64);
    for (const name of [keep, old, "notes"]) writeFileSync(join(root, `${name}.marker`), "");
    for (const name of [keep, old, "notes"]) {
      mkdirSync(join(root, name));
    }
    await new AssetStore(root).prune([keep]);
    expect(readdirSync(root).sort()).toEqual([keep, `${keep}.marker`, `${old}.marker`, "notes", "notes.marker"].sort());
  });
});

function readFile(path: string): Buffer {
  return readFileSync(path);
}
