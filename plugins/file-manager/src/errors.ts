// src/errors.ts — the single place that turns anything thrown into the wire
// shape the contract promises: `Error("<code>: <human readable message>")`.
//
// §4.1: expected failures for single-target RPC methods are thrown; expected
// failures for batch methods land in `failed[]`. Both need the stable code, so
// FileManagerError carries it separately from the formatted message.
import type { FileManagerErrorCode } from "../contract";

/** Node's errno-bearing error shape, narrowed without `any`. */
interface ErrnoLike {
  code?: unknown;
  message?: unknown;
  path?: unknown;
  syscall?: unknown;
}

export class FileManagerError extends Error {
  readonly code: FileManagerErrorCode;
  /** The human-readable half, i.e. `message` without the `"<code>: "` prefix. */
  readonly detail: string;

  constructor(code: FileManagerErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`${code}: ${detail}`, options);
    this.name = "FileManagerError";
    this.code = code;
    this.detail = detail;
  }
}

export function fmError(
  code: FileManagerErrorCode,
  detail: string,
  options?: { cause?: unknown },
): FileManagerError {
  return new FileManagerError(code, detail, options);
}

export function isFileManagerError(error: unknown): error is FileManagerError {
  return error instanceof FileManagerError;
}

/** errno → stable contract code. Anything unmapped degrades to `io_error`. */
const ERRNO_CODES: Readonly<Record<string, FileManagerErrorCode>> = {
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  EROFS: "permission_denied",
  ENOTEMPTY: "not_empty",
  EEXIST: "exists",
  EXDEV: "cross_device",
  ENOSPC: "no_space",
  EDQUOT: "no_space",
  ENOTDIR: "not_a_directory",
  EISDIR: "not_a_file",
  ENAMETOOLONG: "invalid_name",
  EINVAL: "invalid_path",
  ELOOP: "io_error",
  EMFILE: "io_error",
  ENFILE: "io_error",
  EBUSY: "io_error",
  EIO: "io_error",
};

function errnoOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as ErrnoLike).code;
  return typeof code === "string" ? code : null;
}

/**
 * Map a thrown value to a FileManagerError. Already-mapped errors pass through
 * unchanged so callers can wrap freely without losing the original code.
 * `subject` is appended to the message when the errno carries no path.
 */
export function mapNodeError(error: unknown, subject?: string): FileManagerError {
  if (isFileManagerError(error)) return error;

  const errno = errnoOf(error);
  const code: FileManagerErrorCode = (errno && ERRNO_CODES[errno]) || "io_error";
  const rawPath =
    typeof error === "object" && error !== null && typeof (error as ErrnoLike).path === "string"
      ? ((error as ErrnoLike).path as string)
      : undefined;
  const subjectText = subject ?? rawPath;

  let detail: string;
  if (code === "io_error") {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "unexpected filesystem failure";
    detail = subjectText ? `${subjectText}: ${message}` : message;
  } else {
    detail = subjectText ?? (errno ?? "unknown error");
  }
  return new FileManagerError(code, detail, { cause: error });
}

/** Batch-method row for `batchResultSchema.failed[]`. */
export interface BatchFailure {
  path: string;
  code: FileManagerErrorCode;
  message: string;
}

/** Turn any thrown value into one `failed[]` row for the given input path. */
export function toBatchFailure(path: string, error: unknown): BatchFailure {
  const mapped = mapNodeError(error, path);
  return { path, code: mapped.code, message: mapped.detail };
}
