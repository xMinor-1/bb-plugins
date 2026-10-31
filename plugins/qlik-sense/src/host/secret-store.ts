// Where the Qlik password lives on the agent's machine:
//   macOS   — the login Keychain, through the `security` tool;
//   Windows — encrypted with the user's Windows account (DPAPI) through
//             PowerShell, using only cmdlets allowed in Constrained Language Mode;
//   other   — a file only the user can read.
// The password never appears on a command line: it travels on stdin, base64
// encoded so console code pages cannot mangle it. None of these stores keeps the
// password from another program running as the same user — they keep it out of
// plain files, backups and sync folders.
import { spawn } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PasswordStoreKind } from "../../contract.js";

export interface PasswordStore {
  readonly kind: PasswordStoreKind;
  save(password: string): Promise<void>;
  read(): Promise<string | null>;
  clear(): Promise<void>;
}

const SERVICE = "bb-qlik-sense";
const ACCOUNT = "default";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const encode = (password: string) => Buffer.from(password, "utf8").toString("base64");
const decode = (stored: string) => Buffer.from(stored.trim(), "base64").toString("utf8");
const short = (text: string) => text.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";

function keychainStore(): PasswordStore {
  return {
    kind: "keychain",
    async save(password) {
      // `security -i` reads its commands from stdin, so the secret stays off the process list.
      const result = await run("/usr/bin/security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${encode(password)}\n`);
      if (result.code !== 0 || /error|fail/i.test(result.stderr)) {
        throw new Error(`Keychain refused the password: ${short(result.stderr) || `exit ${result.code}`}`);
      }
      if ((await this.read()) !== password) throw new Error("Keychain did not keep the password");
    },
    async read() {
      const result = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], "");
      if (result.code !== 0) return null;
      return decode(result.stdout);
    },
    async clear() {
      await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], "");
    },
  };
}

function powershell(script: string, input: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  // -EncodedCommand sidesteps Windows argument quoting; $input is the piped stdin.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], input, env);
}

function dpapiStore(dataDir: string): PasswordStore {
  const file = join(dataDir, "password.dpapi");
  return {
    kind: "dpapi",
    async save(password) {
      const script = "$p = (@($input) -join '').Trim(); ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString";
      const result = await powershell(script, encode(password), process.env);
      const blob = result.stdout.trim();
      if (result.code !== 0 || blob === "") {
        throw new Error(`Windows could not encrypt the password: ${short(result.stderr) || `exit ${result.code}`}`);
      }
      await writeFile(file, blob, { encoding: "utf8", mode: 0o600 });
      if ((await this.read()) !== password) throw new Error("Windows could not decrypt the saved password");
    },
    async read() {
      let blob: string;
      try {
        blob = (await readFile(file, "utf8")).trim();
      } catch {
        return null;
      }
      const script =
        "$s = ConvertTo-SecureString -String ((@($input) -join '').Trim()); " +
        "(New-Object System.Management.Automation.PSCredential 'qlik', $s).GetNetworkCredential().Password";
      const result = await powershell(script, blob, process.env);
      if (result.code !== 0 || result.stdout.trim() === "") return null;
      return decode(result.stdout);
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}

function fileStore(dataDir: string): PasswordStore {
  const file = join(dataDir, "password");
  return {
    kind: "file",
    async save(password) {
      await writeFile(file, encode(password), { encoding: "utf8", mode: 0o600 });
      await chmod(file, 0o600);
    },
    async read() {
      try {
        return decode(await readFile(file, "utf8"));
      } catch {
        return null;
      }
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}

export function preferredStore(dataDir: string, platform: NodeJS.Platform = process.platform): PasswordStore {
  if (platform === "darwin") return keychainStore();
  if (platform === "win32") return dpapiStore(dataDir);
  return fileStore(dataDir);
}

export function storeOfKind(kind: PasswordStoreKind, dataDir: string): PasswordStore {
  if (kind === "keychain") return keychainStore();
  if (kind === "dpapi") return dpapiStore(dataDir);
  return fileStore(dataDir);
}

/** Saves into the OS store; when the OS refuses (locked-down PowerShell, no Keychain), falls back to the file. */
export async function savePassword(dataDir: string, password: string): Promise<{ kind: PasswordStoreKind; warning: string | null }> {
  const preferred = preferredStore(dataDir);
  if (preferred.kind === "file") {
    await preferred.save(password);
    return { kind: "file", warning: null };
  }
  try {
    await preferred.save(password);
    return { kind: preferred.kind, warning: null };
  } catch (error) {
    const fallback = fileStore(dataDir);
    await fallback.save(password);
    return { kind: "file", warning: error instanceof Error ? error.message : String(error) };
  }
}
