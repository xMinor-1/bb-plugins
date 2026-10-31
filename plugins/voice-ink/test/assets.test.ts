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
