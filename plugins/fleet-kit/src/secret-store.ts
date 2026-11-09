// Secrets live in the operating system's credential store, never in bb's
// database, plugin settings, logs, or OpenCode's configuration files.
//
//   macOS    login Keychain, generic password, service "fleet-kit", account <name>
//   Windows  Credential Manager, generic credential "fleet-kit:<name>"
//   other    a 0600 file in $XDG_DATA_HOME/fleet-kit/secrets (default ~/.local/share)
//
// Secret values never travel in process arguments (endpoint security tools log
// command lines): macOS receives them on stdin, Windows in the child's
// environment. The OpenCode resolver (host/opencode-resolver.ts) reads the
// same locations; keep both sides in step.
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const SECRET_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const KEYCHAIN_SERVICE = "fleet-kit";
export const WINDOWS_TARGET_PREFIX = "fleet-kit:";

export type SecretStoreKind = "keychain" | "credential-manager" | "file";

export interface SecretStore {
  readonly kind: SecretStoreKind;
  /** Where the values live, for display. */
  readonly label: string;
  /** Only for the file store: the directory holding one file per secret. */
  readonly directory: string | null;
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export function secretFileDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith("/") ? env.XDG_DATA_HOME : join(homedir(), ".local", "share");
  return join(base, "fleet-kit", "secrets");
}

function checkName(name: string): void {
  if (!SECRET_NAME.test(name)) throw new Error(`invalid secret name "${name}"`);
}

export function checkSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("the secret is empty");
  if (trimmed.length > 8192) throw new Error("the secret is longer than 8192 characters");
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new Error("the secret contains control characters or line breaks");
  return trimmed;
}

interface RunResult {
  code: number | null;
  stdout: string;
}

function run(command: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const out: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024) out.push(chunk);
    });
    // stderr may echo input on some tools; it is drained and never surfaced.
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8") });
    });
    // A child that exits before reading its input raises EPIPE here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

// ---------------------------------------------------------------- file store

function fileStore(directory: string): SecretStore {
  const pathOf = (name: string) => {
    checkName(name);
    return join(directory, name);
  };
  return {
    kind: "file",
    label: `file (${directory})`,
    directory,
    async has(name) {
      try {
        return (await stat(pathOf(name))).isFile();
      } catch {
        return false;
      }
    },
    async get(name) {
      try {
        const value = (await readFile(pathOf(name), "utf8")).trim();
        return value === "" ? null : value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async set(name, value) {
      const target = pathOf(name);
      const secret = checkSecretValue(value);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700).catch(() => undefined);
      const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${secret}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    },
    async delete(name) {
      try {
        await rm(pathOf(name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

// ------------------------------------------------------------ macOS Keychain

/** The value as `add-generic-password -X` takes it: the hex of its UTF-8 bytes, nothing for `security -i` to split or unquote. */
export function keychainHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

/**
 * The password as `find-generic-password -w` prints it, back to the stored text.
 * `security` prints a plain ASCII value as is and any other value as the hex of
 * its bytes, so hex that decodes to valid UTF-8 with a non-ASCII character is
 * read as such. An ASCII value that happens to be exactly that kind of hex
 * cannot be told apart: set() reads every value back and refuses it.
 */
export function keychainValue(printed: string): string {
  const text = printed.replace(/\r?\n$/, "");
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) return text;
  const bytes = Buffer.from(text, "hex");
  if (!bytes.some((byte) => byte >= 0x80)) return text;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\x00-\x1f\x7f]/.test(decoded) ? text : decoded;
  } catch {
    return text;
  }
}

export const KEYCHAIN_CHANGED = "macOS Keychain gives this value back changed (it reads as hex-encoded text), so it was not kept; use another value";

function keychainStore(security = "/usr/bin/security"): SecretStore {
  return {
    kind: "keychain",
    label: "macOS Keychain",
    directory: null,
    async has(name) {
      checkName(name);
      const result = await run(security, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
      return result.code === 0;
    },
    async get(name) {
      checkName(name);
      const result = await run(security, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
      if (result.code === 44) return null;
      if (result.code !== 0) throw new Error(`macOS Keychain read failed (security exit ${result.code})`);
      const value = keychainValue(result.stdout);
      return value === "" ? null : value;
    },
    async set(name, value) {
      checkName(name);
      const secret = checkSecretValue(value);
      const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -l "Fleet Kit ${name}" -X ${keychainHex(secret)}\n`;
      const result = await run(security, ["-i"], { input: command });
      if (result.code !== 0) throw new Error(`macOS Keychain write failed (security exit ${result.code})`);
      // Read it back: a value `security` would print differently is removed, not kept half-right.
      const stored = await this.get(name);
      if (stored === secret) return;
      if (stored !== null) await this.delete(name);
      throw new Error(stored === null ? "macOS Keychain did not keep the secret" : KEYCHAIN_CHANGED);
    },
    async delete(name) {
      checkName(name);
      const result = await run(security, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
      return result.code === 0;
    },
  };
}

// ---------------------------------------------- Windows Credential Manager

/** Reads FLEET_KIT_SECRET_ACTION / _TARGET / _VALUE from its environment. */
// Ends with an empty line: `powershell -Command -` reads stdin line by line and runs a
// multi-line statement only after a blank line. Without it the script does not run at all.
export const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Take the value out of the environment before Add-Type starts the C# compiler,
# which would inherit it.
$secretValue = $env:FLEET_KIT_SECRET_VALUE
Remove-Item Env:FLEET_KIT_SECRET_VALUE -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FleetKitCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);
  public static void Write(string target, string secret) {
    byte[] blob = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = "fleet-kit"; c.Persist = 2;
    c.CredentialBlobSize = blob.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == 1168) return null;
      throw new System.ComponentModel.Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] blob = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, blob, 0, c.CredentialBlobSize);
      return Encoding.UTF8.GetString(blob);
    } finally { CredFree(p); }
  }
  public static bool Delete(string target) {
    if (CredDeleteW(target, 1, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == 1168) return false;
    throw new System.ComponentModel.Win32Exception(e);
  }
}
'@
$target = $env:FLEET_KIT_SECRET_TARGET
switch ($env:FLEET_KIT_SECRET_ACTION) {
  'write' { [FleetKitCredential]::Write($target, $secretValue); exit 0 }
  'read' { $v = [FleetKitCredential]::Read($target); if ($null -eq $v) { exit 3 }; $b = [Text.Encoding]::UTF8.GetBytes($v); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length); $o.Flush(); exit 0 }
  'exists' { $v = [FleetKitCredential]::Read($target); if ($null -eq $v) { exit 3 }; exit 0 }
  'delete' { if ([FleetKitCredential]::Delete($target)) { exit 0 } else { exit 3 } }
  default { exit 2 }
}

`;

function credentialManagerStore(): SecretStore {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const call = async (action: string, name: string, value?: string) => {
    checkName(name);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FLEET_KIT_SECRET_ACTION: action,
      FLEET_KIT_SECRET_TARGET: `${WINDOWS_TARGET_PREFIX}${name}`,
    };
    if (value !== undefined) env.FLEET_KIT_SECRET_VALUE = value;
    const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      input: WINDOWS_CREDENTIAL_SCRIPT,
      env,
      timeoutMs: 60_000,
    });
    if (result.code !== 0 && result.code !== 3) {
      throw new Error(`Windows Credential Manager ${action} failed (PowerShell exit ${result.code}); a policy may block Add-Type, set secretStore to "file"`);
    }
    return result;
  };
  return {
    kind: "credential-manager",
    label: "Windows Credential Manager",
    directory: null,
    async has(name) {
      return (await call("exists", name)).code === 0;
    },
    async get(name) {
      const result = await call("read", name);
      if (result.code === 3 || result.stdout === "") return null;
      return result.stdout;
    },
    async set(name, value) {
      await call("write", name, checkSecretValue(value));
    },
    async delete(name) {
      return (await call("delete", name)).code === 0;
    },
  };
}

export type SecretStorePreference = "auto" | "file";

/**
 * Remember whether each secret is present for a short while: the panel asks on
 * every redraw, and on Windows every question starts PowerShell. Writes and
 * deletes through this store refresh the answer at once.
 */
export function withPresenceCache(inner: SecretStore, ttlMs = 30_000): SecretStore {
  const known = new Map<string, { at: number; present: boolean }>();
  return {
    kind: inner.kind,
    label: inner.label,
    directory: inner.directory,
    async has(name) {
      const hit = known.get(name);
      if (hit && Date.now() - hit.at < ttlMs) return hit.present;
      const present = await inner.has(name);
      known.set(name, { at: Date.now(), present });
      return present;
    },
    get: (name) => inner.get(name),
    async set(name, value) {
      known.delete(name);
      await inner.set(name, value);
      known.set(name, { at: Date.now(), present: true });
    },
    async delete(name) {
      known.delete(name);
      const removed = await inner.delete(name);
      known.set(name, { at: Date.now(), present: false });
      return removed;
    },
  };
}

export function openSecretStore(preference: SecretStorePreference = "auto", platform: NodeJS.Platform = process.platform): SecretStore {
  if (preference === "file") return fileStore(secretFileDirectory());
  if (platform === "darwin") return withPresenceCache(keychainStore());
  if (platform === "win32") return withPresenceCache(credentialManagerStore());
  return fileStore(secretFileDirectory());
}

/** For tests: a file store rooted anywhere. */
export function openFileSecretStore(directory: string): SecretStore {
  return fileStore(directory);
}

/** For tests: the Keychain store driven by another `security` program. */
export function openKeychainSecretStore(security: string): SecretStore {
  return keychainStore(security);
}
