import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureOpenCode, extractEntry, runProgram, type OpenCodeFile, type RunOutcome } from "../src/host/install-opencode.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fk-install-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A package like npm's: package/bin/<program> among other files. */
function makePackage(script: string, program = "opencode"): { archive: string; integrity: string } {
  const root = temp();
  mkdirSync(join(root, "package", "bin"), { recursive: true });
  writeFileSync(join(root, "package", "package.json"), "{}");
  writeFileSync(join(root, "package", "bin", program), script);
  chmodSync(join(root, "package", "bin", program), 0o755);
  const archive = join(temp(), "p.tgz");
  execFileSync("tar", ["czf", archive, "-C", root, "package"]);
  return { archive, integrity: `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}` };
}

const never = new AbortController().signal;
const key = `${process.platform}-${process.arch}`;
const versionScript = (version: string) => `#!/bin/sh\necho "opencode v${version}"\n`;

function deps(directory: string, file: OpenCodeFile, extra: Partial<Parameters<typeof ensureOpenCode>[0]> = {}) {
  return {
    directory,
    version: "2.2.5",
    files: { [key]: file },
    signal: never,
    delays: [0, 0],
    download: async (url: string, target: string) => writeFileSync(target, readFileSync(url)),
    ...extra,
  };
}

describe("extractEntry", () => {
  it("takes the one program out of the package, whole", async () => {
    const big = `#!/bin/sh\n# ${"x".repeat(70_000)}\n`;
    const { archive } = makePackage(big);
    const target = join(temp(), "out");
    expect(await extractEntry(archive, "package/bin/opencode", target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(big);
  });

  it("says when the package has no such file", async () => {
    const { archive } = makePackage("x");
    expect(await extractEntry(archive, "package/bin/other", join(temp(), "out"))).toBe(false);
  });
});

describe("ensureOpenCode", () => {
  it("installs the listed version and runs it", async () => {
    const { archive, integrity } = makePackage(versionScript("2.2.5"));
    const dir = temp();
    const outcome = await ensureOpenCode(deps(dir, { url: archive, integrity, entry: "package/bin/opencode" }));
    expect(outcome).toMatchObject({ state: "installed", version: "2.2.5", path: join(dir, "opencode") });
    expect(readdirSync(dir)).toEqual(["opencode"]);
  });

  it("does nothing when that version is in place", async () => {
    const { archive, integrity } = makePackage(versionScript("2.2.5"));
    const dir = temp();
    const file = { url: archive, integrity, entry: "package/bin/opencode" };
    await ensureOpenCode(deps(dir, file));
    let downloads = 0;
    const outcome = await ensureOpenCode(deps(dir, file, { download: async () => void (downloads += 1) }));
    expect(outcome.state).toBe("current");
    expect(downloads).toBe(0);
  });

  it("replaces another version in place", async () => {
    const old = makePackage(versionScript("2.2.4"));
    const dir = temp();
    await ensureOpenCode(deps(dir, { url: old.archive, integrity: old.integrity, entry: "package/bin/opencode" }, { version: "2.2.4" }));
    const fresh = makePackage(versionScript("2.2.5"));
    const outcome = await ensureOpenCode(deps(dir, { url: fresh.archive, integrity: fresh.integrity, entry: "package/bin/opencode" }));
    expect(outcome.state).toBe("installed");
    expect(readFileSync(join(dir, "opencode"), "utf8")).toContain("2.2.5");
    expect(readdirSync(dir)).toEqual(["opencode"]);
  });

  it("refuses a file that does not match the hash and leaves nothing to run", async () => {
    const { archive } = makePackage(versionScript("2.2.5"));
    const dir = temp();
    const outcome = await ensureOpenCode(deps(dir, { url: archive, integrity: `sha512-${"A".repeat(86)}==`, entry: "package/bin/opencode" }));
    expect(outcome).toMatchObject({ state: "failed", reason: "integrity" });
    expect(existsSync(join(dir, "opencode"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("tries a failed download again, then reports it", async () => {
    const { archive, integrity } = makePackage(versionScript("2.2.5"));
    let tries = 0;
    const flaky = async (url: string, target: string) => {
      tries += 1;
      if (tries < 3) throw new Error("connection reset");
      writeFileSync(target, readFileSync(url));
    };
    const file = { url: archive, integrity, entry: "package/bin/opencode" };
    expect((await ensureOpenCode(deps(temp(), file, { download: flaky }))).state).toBe("installed");
    expect(tries).toBe(3);
    const down = await ensureOpenCode(deps(temp(), file, { download: async () => { throw new Error("connection reset"); } }));
    expect(down).toMatchObject({ state: "failed", reason: "download", detail: "connection reset" });
  });

  it("stops at a refusal to run: one attempt, the path named, no other way tried", async () => {
    const { archive, integrity } = makePackage(versionScript("2.2.5"));
    const dir = temp();
    const runs: string[] = [];
    const run = async (path: string): Promise<RunOutcome> => {
      runs.push(path);
      return { kind: "denied", detail: "EACCES" };
    };
    const outcome = await ensureOpenCode(deps(dir, { url: archive, integrity, entry: "package/bin/opencode" }, { run }));
    expect(outcome).toMatchObject({ state: "failed", reason: "denied", path: join(dir, "opencode"), detail: "EACCES" });
    expect(runs).toEqual([join(dir, "opencode")]);
  });

  it("does not download again when the program in place is refused", async () => {
    const dir = temp();
    writeFileSync(join(dir, "opencode"), "x");
    let downloads = 0;
    const outcome = await ensureOpenCode(deps(dir, { url: "u", integrity: "i", entry: "e" }, {
      download: async () => void (downloads += 1),
      run: async () => ({ kind: "denied", detail: "EPERM" }),
    }));
    expect(outcome).toMatchObject({ state: "failed", reason: "denied" });
    expect(downloads).toBe(0);
  });

  it("falls to the baseline build only for a processor that cannot run the normal one", async () => {
    const normal = makePackage(versionScript("2.2.5"));
    const baseline = makePackage(versionScript("2.2.5"));
    const dir = temp();
    const urls: string[] = [];
    let runs = 0;
    const outcome = await ensureOpenCode({
      ...deps(dir, { url: normal.archive, integrity: normal.integrity, entry: "package/bin/opencode" }),
      files: {
        [key]: { url: normal.archive, integrity: normal.integrity, entry: "package/bin/opencode" },
        [`${key}-baseline`]: { url: baseline.archive, integrity: baseline.integrity, entry: "package/bin/opencode" },
      },
      download: async (url, target) => {
        urls.push(url);
        writeFileSync(target, readFileSync(url));
      },
      run: async (): Promise<RunOutcome> => (runs++ === 0 ? { kind: "unsupported-cpu", detail: "SIGILL" } : { kind: "ok", version: "2.2.5" }),
    });
    expect(outcome.state).toBe("installed");
    expect(urls).toEqual([normal.archive, baseline.archive]);
  });

  it("says when the build has nothing for this computer", async () => {
    const outcome = await ensureOpenCode(deps(temp(), { url: "u", integrity: "i", entry: "e" }, { arch: "riscv" }));
    expect(outcome).toMatchObject({ state: "failed", reason: "no-file" });
  });
});

describe("runProgram", () => {
  it("treats a program it may not start as a refusal", async () => {
    const dir = temp();
    const program = join(dir, "opencode");
    writeFileSync(program, "#!/bin/sh\necho 1\n");
    chmodSync(program, 0o644);
    expect((await runProgram(program)).kind).toBe("denied");
  });

  it("treats a start that throws, as Windows does on a refusal, as a refusal", async () => {
    // A NUL in the path makes spawn throw at once on every system, the way ERROR_ACCESS_DENIED does on Windows.
    expect((await runProgram("opencode\0denied")).kind).toBe("denied");
  });

  it("reads the version; another failure is not a refusal", async () => {
    const dir = temp();
    const program = join(dir, "opencode");
    writeFileSync(program, versionScript("2.2.5"));
    chmodSync(program, 0o755);
    expect(await runProgram(program)).toEqual({ kind: "ok", version: "2.2.5" });
    writeFileSync(program, "#!/bin/sh\nexit 3\n");
    expect((await runProgram(program)).kind).toBe("broken");
  });
});
