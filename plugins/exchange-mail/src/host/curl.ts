// HTTP to Exchange through the operating system's own curl.
//
// Why curl and not Node's http: Exchange on-premises signs people in with
// Negotiate (Kerberos) or NTLM. The curl that ships with Windows 10/11 does
// Negotiate through SSPI as the signed-in Windows user, so a domain laptop needs
// no password at all; macOS curl does Negotiate with the Kerberos ticket from
// the system. Node has neither without native modules.
//
// Everything secret or large travels on stdin as a curl config file (`-K -`):
// command lines are visible to every process and logged by endpoint security
// tools. `-q` comes first so a user's .curlrc cannot change the request.
import { spawn } from "node:child_process";
import { join } from "node:path";

export type HttpAuth =
  | { readonly kind: "negotiate" }
  | { readonly kind: "ntlm"; readonly user: string; readonly password: string }
  | { readonly kind: "basic"; readonly user: string; readonly password: string };

export interface HttpRequest {
  readonly url: string;
  readonly body: string;
  readonly auth: HttpAuth;
  readonly headers?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type TransportErrorCode = "curl-missing" | "unreachable" | "tls" | "timeout" | "aborted" | "failed";

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CurlInfo {
  readonly path: string;
  readonly version: string | null;
  readonly features: readonly string[];
}

export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
  info(): Promise<CurlInfo>;
}

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const STATUS_MARKER = "\n#bb-exchange-mail-status:";

export function defaultCurlPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.EXCHANGE_MAIL_CURL) return env.EXCHANGE_MAIL_CURL;
  // Absolute paths: a curl earlier on PATH (Git for Windows, Homebrew) may lack SSPI or the system trust store.
  if (platform === "win32") return join(env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe");
  if (platform === "darwin") return "/usr/bin/curl";
  return "curl";
}

/** A curl config-file string: quotes, backslashes and line breaks escaped. */
export function configString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** The curl config for one request. Exported for tests. */
export function buildCurlConfig(request: HttpRequest, options: { revokeBestEffort: boolean; timeoutMs: number }): string {
  if (/[\r\n]/.test(request.url)) throw new TransportError("failed", "The address contains a line break");
  const lines = [
    "silent",
    "show-error",
    `url = ${configString(request.url)}`,
    `request = "POST"`,
    `header = "Content-Type: text/xml; charset=utf-8"`,
    `header = "Accept: text/xml"`,
    ...(request.headers ?? []).map((header) => `header = ${configString(header)}`),
    `data-binary = ${configString(request.body)}`,
    `connect-timeout = 15`,
    `max-time = ${Math.max(5, Math.ceil(options.timeoutMs / 1000))}`,
    `write-out = ${configString(`${STATUS_MARKER}%{http_code}`)}`,
  ];
  switch (request.auth.kind) {
    case "negotiate":
      // An empty user and password: SSPI (Windows) or the Kerberos ticket (macOS, Linux) supplies who we are.
      lines.push("negotiate", `user = ":"`);
      break;
    case "ntlm":
      lines.push("ntlm", `user = ${configString(`${request.auth.user}:${request.auth.password}`)}`);
      break;
    case "basic":
      lines.push("basic", `user = ${configString(`${request.auth.user}:${request.auth.password}`)}`);
      break;
  }
  // Corporate CAs often publish revocation lists only inside the network; Schannel then refuses the connection.
  if (options.revokeBestEffort) lines.push("ssl-revoke-best-effort");
  return `${lines.join("\n")}\n`;
}

interface RunOutput {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function run(path: string, args: string[], input: string, timeoutMs: number, signal?: AbortSignal): Promise<RunOutput> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(path, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, timeoutMs + 10_000);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      finish();
      if (!settled) {
        settled = true;
        resolve({ code, stdout: Buffer.concat(chunks), stderr });
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input, "utf8");
  });
}

/** curl exit codes worth a plain-language message. */
function curlFailure(code: number | null, stderr: string): TransportError {
  const detail = stderr.trim().split(/\r?\n/)[0]?.replace(/^curl: \(\d+\)\s*/, "").slice(0, 300) ?? "";
  switch (code) {
    case 5:
    case 6:
    case 7:
      return new TransportError("unreachable", `Exchange is not reachable from this machine (${detail || `curl exit ${code}`}). Check the corporate network or VPN.`);
    case 28:
      return new TransportError("timeout", "Exchange did not answer in time. Check the corporate network or VPN.");
    case 35:
    case 51:
    case 53:
    case 54:
    case 58:
    case 59:
    case 60:
    case 77:
    case 80:
    case 83:
    case 90:
    case 91:
      return new TransportError("tls", `The secure connection to Exchange failed: ${detail || `curl exit ${code}`}`);
    case 52:
    case 55:
    case 56:
      return new TransportError("unreachable", `The connection to Exchange broke off (${detail || `curl exit ${code}`}).`);
    default:
      return new TransportError("failed", `curl failed: ${detail || `exit ${code}`}`);
  }
}

export function parseCurlVersion(text: string): { version: string | null; features: string[] } {
  const version = /^curl\s+(\d+\.\d+(?:\.\d+)?)/m.exec(text)?.[1] ?? null;
  const features = /^Features:\s*(.*)$/m.exec(text)?.[1]?.trim().split(/\s+/) ?? [];
  return { version, features };
}

function atLeast(version: string | null, major: number, minor: number): boolean {
  if (!version) return false;
  const [a = 0, b = 0] = version.split(".").map(Number);
  return a > major || (a === major && b >= minor);
}

export function curlTransport(options: { path?: string; platform?: NodeJS.Platform } = {}): Transport {
  const platform = options.platform ?? process.platform;
  const path = options.path ?? defaultCurlPath(platform);
  let infoPromise: Promise<CurlInfo> | null = null;

  const info = (): Promise<CurlInfo> => {
    infoPromise ??= run(path, ["-q", "--version"], "", 10_000).then(
      (out) => {
        if (out.code !== 0) throw new TransportError("curl-missing", `curl at ${path} did not start (exit ${out.code})`);
        return { path, ...parseCurlVersion(out.stdout.toString("utf8")) };
      },
      (error: NodeJS.ErrnoException) => {
        throw new TransportError("curl-missing", error.code === "ENOENT" ? `curl is not installed at ${path}` : `curl did not start: ${error.message}`);
      },
    );
    infoPromise.catch(() => {
      infoPromise = null;
    });
    return infoPromise;
  };

  return {
    info,
    async send(request) {
      const curl = await info();
      const timeoutMs = request.timeoutMs ?? 90_000;
      const config = buildCurlConfig(request, {
        // The option exists from curl 7.70 and only means something with Schannel.
        revokeBestEffort: platform === "win32" && atLeast(curl.version, 7, 70),
        timeoutMs,
      });
      if (request.signal?.aborted) throw new TransportError("aborted", "The request was cancelled");
      const out = await run(path, ["-q", "-K", "-"], config, timeoutMs, request.signal).catch((error: Error) => {
        throw new TransportError("curl-missing", `curl did not start: ${error.message}`);
      });
      if (request.signal?.aborted) throw new TransportError("aborted", "The request was cancelled");
      if (out.code !== 0) throw curlFailure(out.code, out.stderr);
      const text = out.stdout.toString("utf8");
      const at = text.lastIndexOf(STATUS_MARKER);
      if (at < 0) throw new TransportError("failed", "curl returned no status");
      const status = Number(text.slice(at + STATUS_MARKER.length).trim());
      return { status: Number.isFinite(status) ? status : 0, body: text.slice(0, at) };
    },
  };
}
