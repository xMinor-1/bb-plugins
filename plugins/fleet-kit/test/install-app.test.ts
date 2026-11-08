// Installing a program a plugin needs: parts checked one by one and joined, the whole package checked, unpacked
// into a fresh folder, recorded, and found again on the next sync without a download.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { APP_STATE_FILE, ensureApp, unpackWithSystemTools, type AppFile, type AppInstallDeps } from "../src/host/install-app.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fk-app-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stored (uncompressed) zip: enough for the system's unzip. */
export function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const never = new AbortController().signal;

/** A package served from memory in `parts` pieces. */
function served(data: Buffer, parts = 3) {
  const size = Math.ceil(data.length / parts);
  const pieces = Array.from({ length: parts }, (_, index) => data.subarray(index * size, (index + 1) * size));
  const urls = pieces.map((_, index) => `https://files.example.test/pkg.part-${index}`);
  const fetched: string[] = [];
  const broken = new Set<string>();
  const download = async (url: string, file: string) => {
    fetched.push(url);
    const index = urls.indexOf(url);
    writeFileSync(file, broken.has(url) ? Buffer.from("not the part") : pieces[index]!);
  };
  const file: AppFile = { format: "zip", parts: urls.map((url, index) => ({ url, sha256: sha(pieces[index]!) })), sha256: sha(data), program: "Office/program/soffice" };
  return { file, download, fetched, broken, urls };
}

const zip = makeZip({ "Office/program/soffice": "#!/bin/sh\n", "Office/program/libswlo.so": "writer" });

function deps(directory: string, file: AppFile, extra: Partial<AppInstallDeps> = {}): AppInstallDeps {
  return { directory, version: "26.8.2", file, signal: never, platform: "linux", delays: [0, 0], ...extra };
}

describe("installing a program", () => {
  it("joins checked parts, unpacks them with the system's tools and records the program", async () => {
    const directory = join(temp(), "office");
    const pkg = served(zip);
    const outcome = await ensureApp(deps(directory, pkg.file, { download: pkg.download }));
    expect(outcome.state).toBe("installed");
    const path = (outcome as { path: string }).path;
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\n");
    expect(path.startsWith(directory)).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, APP_STATE_FILE), "utf8"))).toMatchObject({ version: "26.8.2", sha256: pkg.file.sha256, program: "Office/program/soffice" });
    // Only the version folder and the record stay: no download left behind.
    expect(readdirSync(directory).sort()).toEqual([APP_STATE_FILE, readdirSync(directory).find((name) => name.startsWith("26.8.2-"))].sort());
  });

  it("finds the installed program again without downloading", async () => {
    const directory = join(temp(), "office");
    const pkg = served(zip);
    const first = await ensureApp(deps(directory, pkg.file, { download: pkg.download }));
    pkg.fetched.length = 0;
    const second = await ensureApp(deps(directory, pkg.file, { download: pkg.download }));
    expect(second).toEqual({ state: "current", path: (first as { path: string }).path });
    expect(pkg.fetched).toEqual([]);
  });

  it("refuses a part that does not match its hash, after the retries, and installs nothing", async () => {
    const directory = join(temp(), "office");
    const pkg = served(zip);
    pkg.broken.add(pkg.urls[1]!);
    const outcome = await ensureApp(deps(directory, pkg.file, { download: pkg.download }));
    expect(outcome).toMatchObject({ state: "failed", reason: "integrity" });
    expect(pkg.fetched.filter((url) => url === pkg.urls[1])).toHaveLength(3);
    expect(pkg.fetched).not.toContain(pkg.urls[2]);
    expect(existsSync(join(directory, APP_STATE_FILE))).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("refuses a package whose joined file does not match", async () => {
    const pkg = served(zip);
    const outcome = await ensureApp(deps(join(temp(), "office"), { ...pkg.file, sha256: "0".repeat(64) }, { download: pkg.download }));
    expect(outcome).toMatchObject({ state: "failed", reason: "integrity" });
  });

  it("says when the package has no such program", async () => {
    const pkg = served(zip);
    const outcome = await ensureApp(deps(join(temp(), "office"), { ...pkg.file, program: "Office/program/missing" }, { download: pkg.download }));
    expect(outcome).toMatchObject({ state: "failed", reason: "unpack" });
  });

  it("puts a new version in a new folder, then removes the old one", async () => {
    const directory = join(temp(), "office");
    const pkg = served(zip);
    const first = (await ensureApp(deps(directory, pkg.file, { download: pkg.download }))) as { path: string };
    const next = makeZip({ "Office/program/soffice": "#!/bin/sh\necho new\n" });
    const pkg2 = served(next, 2);
    const second = (await ensureApp(deps(directory, pkg2.file, { version: "26.8.3", download: pkg2.download }))) as { state: string; path: string };
    expect(second.state).toBe("installed");
    expect(second.path).not.toBe(first.path);
    expect(existsSync(first.path)).toBe(false);
    expect(readFileSync(second.path, "utf8")).toContain("new");
  });

  it("installs again when the recorded program is gone", async () => {
    const directory = join(temp(), "office");
    const pkg = served(zip);
    const first = (await ensureApp(deps(directory, pkg.file, { download: pkg.download }))) as { path: string };
    rmSync(first.path);
    const again = await ensureApp(deps(directory, pkg.file, { download: pkg.download }));
    expect(again.state).toBe("installed");
  });

  it("fetches nothing while downloads are paused", async () => {
    const pkg = served(zip);
    const outcome = await ensureApp(deps(join(temp(), "office"), pkg.file, { download: pkg.download, mayDownload: false }));
    expect(outcome).toMatchObject({ state: "failed", reason: "paused" });
    expect(pkg.fetched).toEqual([]);
  });

  it("reports an unpacking tool that fails, and leaves no half folder", async () => {
    const directory = join(temp(), "office");
    const pkg = served(zip);
    const outcome = await ensureApp(deps(directory, pkg.file, { download: pkg.download, unpack: async () => Promise.reject(new Error("tar ended with code 1")) }));
    expect(outcome).toEqual({ state: "failed", reason: "unpack", detail: "tar ended with code 1" });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("opens a .dmg only on macOS", async () => {
    await expect(unpackWithSystemTools("dmg", "/nowhere.dmg", join(temp(), "t"), "Office.app/Contents/MacOS/soffice", "linux")).rejects.toThrow(/only on macOS/);
  });

  it("downloads over the network with fetch, refusing an error answer", async () => {
    const pkg = served(zip, 1);
    const outcome = await ensureApp(deps(join(temp(), "office"), { ...pkg.file, parts: [{ url: "http://127.0.0.1:9/none", sha256: pkg.file.parts[0]!.sha256 }] }));
    expect(outcome).toMatchObject({ state: "failed", reason: "download" });
  });
});

// The real unzip of this machine, as on a person's Linux; Windows uses tar.exe and macOS ditto the same way.
describe.runIf(existsSync("/usr/bin/unzip"))("the system's unzip", () => {
  it("unpacks the whole tree", async () => {
    const archive = join(temp(), "p.zip");
    writeFileSync(archive, zip);
    const target = join(temp(), "out");
    await unpackWithSystemTools("zip", archive, target, "Office/program/soffice", "linux");
    expect(execFileSync("ls", [join(target, "Office", "program")]).toString().split("\n").filter(Boolean).sort()).toEqual(["libswlo.so", "soffice"]);
  });
});
