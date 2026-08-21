// lib/errors.ts — turning wire failures into something a panel can render.
//
// Every backend handler throws `Error("<code>: <human readable message>")`
// (§4 of SPEC.md). The host wraps that in `{ ok: false, error: { code:
// "handler_error", message } }` and `useRpc().call()` rejects with an `Error`
// carrying that message plus the transport-level `code`. Recovering the
// *domain* code therefore means splitting the message on the first ": " and
// checking the prefix against the frozen enum — that is `parseRpcError`.
import { errorCodeSchema, type FileManagerErrorCode } from "../contract";

const ERROR_CODES: ReadonlySet<string> = new Set<string>(errorCodeSchema.options);

/** Transport-level codes the host itself can produce (never domain codes). */
const WIRE_CODES: ReadonlySet<string> = new Set([
  "handler_error",
  "invalid_input",
  "invalid_json",
  "invalid_output",
  "non_json_result",
  "unknown_method",
]);

export interface ParsedRpcError {
  /** Domain code when the message carried one, else null. */
  code: FileManagerErrorCode | null;
  /** The message with the `"<code>: "` prefix removed. */
  message: string;
  /** The untouched message as it arrived. */
  rawMessage: string;
  /** The host's transport code (`handler_error`, `invalid_input`, …). */
  wireCode: string | null;
}

export function isFileManagerErrorCode(value: unknown): value is FileManagerErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

function readString(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Best-effort extraction of a human message out of anything a promise rejected with. */
function rawMessageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const message = readString(error, "message");
  if (message !== null) return message;
  if (error === undefined || error === null) return "";
  try {
    return String(error);
  } catch {
    return "";
  }
}

/**
 * Split `"not_found: /home/coder/x"` into its parts. Messages without a known
 * code prefix are returned verbatim with `code: null`, so this is safe to call
 * on validation failures, network errors and thrown strings alike.
 */
export function parseRpcError(error: unknown): ParsedRpcError {
  if (error instanceof FileManagerRpcError) {
    return {
      code: error.code,
      message: error.message,
      rawMessage: error.rawMessage,
      wireCode: error.wireCode,
    };
  }

  const rawMessage = rawMessageOf(error);
  const wireCandidate = readString(error, "code");
  const wireCode =
    wireCandidate !== null && WIRE_CODES.has(wireCandidate) ? wireCandidate : null;

  const separator = rawMessage.indexOf(": ");
  if (separator > 0) {
    const prefix = rawMessage.slice(0, separator);
    if (ERROR_CODES.has(prefix)) {
      return {
        code: prefix as FileManagerErrorCode,
        message: rawMessage.slice(separator + 2).trim(),
        rawMessage,
        wireCode,
      };
    }
  }

  // A domain code can also arrive as the whole message (batch `failed[]`
  // entries carry `code` and `message` separately, and some callers pass the
  // bare code through).
  if (ERROR_CODES.has(rawMessage)) {
    return {
      code: rawMessage as FileManagerErrorCode,
      message: describeErrorCode(rawMessage as FileManagerErrorCode),
      rawMessage,
      wireCode,
    };
  }

  return { code: null, message: rawMessage, rawMessage, wireCode };
}

/** An RPC rejection with the domain code already recovered. */
export class FileManagerRpcError extends Error {
  readonly code: FileManagerErrorCode | null;
  readonly wireCode: string | null;
  readonly rawMessage: string;

  constructor(parsed: ParsedRpcError, options?: { cause?: unknown }) {
    super(parsed.message === "" ? parsed.rawMessage : parsed.message, options);
    this.name = "FileManagerRpcError";
    this.code = parsed.code;
    this.wireCode = parsed.wireCode;
    this.rawMessage = parsed.rawMessage;
  }
}

/** Normalizes anything thrown by `rpc.call()` into a `FileManagerRpcError`. */
export function toFileManagerError(error: unknown): FileManagerRpcError {
  if (error instanceof FileManagerRpcError) return error;
  return new FileManagerRpcError(parseRpcError(error), { cause: error });
}

const CODE_TEXT: Record<FileManagerErrorCode, string> = {
  invalid_path: "That path is not valid.",
  invalid_name: "That name is not allowed.",
  path_escape: "That path is outside the file manager root.",
  not_found: "That item no longer exists.",
  not_a_directory: "That path is not a folder.",
  not_a_file: "That path is not a file.",
  exists: "An item with that name already exists.",
  not_empty: "That folder is not empty.",
  permission_denied: "Permission denied.",
  cross_device: "That move crossed a filesystem boundary and failed.",
  destination_inside_source: "A folder cannot be moved into itself.",
  unsupported_archive: "That archive format is not supported.",
  archive_failed: "Extraction failed.",
  upload_not_found: "The upload session expired.",
  upload_busy: "Another chunk of this upload is still in flight.",
  offset_mismatch: "The upload lost sync and has to resume.",
  size_mismatch: "The file changed while it was uploading.",
  no_space: "There is not enough free disk space.",
  io_error: "The filesystem reported an error.",
  unsupported: "That operation is not supported.",
};

/** One short, user-facing sentence for a domain code. */
export function describeErrorCode(code: FileManagerErrorCode): string {
  return CODE_TEXT[code];
}

/**
 * Toast text for a rejection: the friendly sentence when the code is known,
 * the server's own message otherwise.
 */
export function errorToastText(error: unknown, fallback = "Something went wrong."): string {
  const parsed = parseRpcError(error);
  if (parsed.code !== null) return describeErrorCode(parsed.code);
  const message = parsed.message.trim();
  return message === "" ? fallback : message;
}

/** Alias kept because "toast text" is how §8 names this helper. */
export const toastText = errorToastText;

export interface BatchFailure {
  path: string;
  code: FileManagerErrorCode;
  message: string;
}

/**
 * Summarizes the `failed[]` half of a batch result. Returns null when nothing
 * failed, so callers can `if (text) toast.error(text)`.
 */
export function batchFailureText(
  failed: readonly BatchFailure[],
  action = "operation",
): string | null {
  if (failed.length === 0) return null;
  const first = failed[0];
  if (first === undefined) return null;
  const name = baseNameOf(first.path);
  const reason = describeErrorCode(first.code);
  if (failed.length === 1) return `${name}: ${reason}`;
  return `${failed.length} items failed to ${action}. ${name}: ${reason}`;
}

/** Local basename so this module stays free of path-module imports. */
function baseNameOf(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}
