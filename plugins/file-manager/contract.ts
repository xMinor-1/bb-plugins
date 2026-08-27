// contract.ts — frozen wire contract between the File Manager backend and panel.
// Any change here is a breaking change: bump the plugin version and update both
// sides in the same commit.
import type { PluginRpcContract } from "@get-bb/plugin-sdk";

/**
 * Type-only identity helper, deliberately local.
 *
 * The SDK exports `defineRpcContract`, but importing it as a *value* pulls
 * `@get-bb/plugin-sdk` into the frontend bundle graph (app.tsx imports this
 * file for its constants). bb only shims the `/app` subpath, and a catalog
 * install runs `npm install --omit=dev` before bundling — so a value import
 * here breaks installs unless the SDK is a runtime dependency, which
 * `bb plugin types --check` then rejects. The SDK helper is `c => c`; the
 * type-only import below is erased at build time and costs nothing.
 */
const defineRpcContract = <const Contract extends PluginRpcContract>(
  contract: Contract,
): Contract => contract;
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Constants shared by both sides                                      */
/* ------------------------------------------------------------------ */

export const PLUGIN_ID = "file-manager";
/** navPanel `path` — the panel lives at /plugins/file-manager/files/* */
export const PANEL_PATH = "files";
export const RPC_BASE = `/api/v1/plugins/${PLUGIN_ID}/rpc`;
export const HTTP_BASE = `/api/v1/plugins/${PLUGIN_ID}/http`;
export const TOKEN_URL = `/api/v1/plugins/${PLUGIN_ID}/token`;
export const UPLOAD_CHUNK_URL = `${HTTP_BASE}/upload/chunk`;
export const DOWNLOAD_URL = `${HTTP_BASE}/download`;

/**
 * Extensions the file-location openers claim (§10.2).
 *
 * bb matches an opener by exact extension — there is no wildcard, and a name
 * with no extension at all (`Makefile`, `LICENSE`) gets no "Open with" rows
 * from any plugin — so this list is simply "what a link in a message
 * plausibly points at": text, docs, office, config, data, code, web, images,
 * audio, video, archives, fonts and binaries.
 *
 * `pdf` is deliberately absent: the pdf-viewer plugin owns it, and two plugins
 * claiming one extension makes bb's automatic pick depend on load order.
 */
export const LOCATION_OPENER_EXTENSIONS = [
  // text and docs
  "md", "mdx", "markdown", "txt", "rst", "adoc", "org", "tex", "rtf",
  // office and ebooks
  "doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub",
  "pages", "numbers", "key",
  // config and data
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "csv", "tsv", "xml", "sql", "log", "lock", "properties", "plist", "db",
  "sqlite", "sqlite3", "parquet", "ndjson", "har", "ics", "vcf",
  // code
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "pyi", "ipynb", "rb", "go",
  "rs", "java", "kt", "kts", "swift", "m", "mm", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "lua", "r",
  "pl", "scala", "clj", "cljs", "ex", "exs", "erl", "hs", "ml", "dart", "vue",
  "svelte", "astro", "graphql", "gql", "proto", "diff", "patch", "gradle",
  "cmake", "mk", "asm", "vb", "f90", "jl", "nim", "zig", "sol", "tf", "tfvars",
  "hcl", "nix", "bzl",
  // web
  "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl", "map",
  // images
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "tif",
  "tiff", "heic", "psd", "ai", "eps",
  // audio and video
  "mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus", "aiff",
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg",
  // archives — the plugin extracts several of these itself
  "zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "7z", "rar", "zst",
  "lz4", "iso", "dmg", "jar", "war", "whl", "gem", "crate", "nupkg", "xpi",
  "vsix", "apk", "aab", "ipa", "deb", "rpm", "pkg", "msi", "appimage", "snap",
  "flatpak", "cab",
  // fonts and binaries
  "ttf", "otf", "woff", "woff2", "eot", "exe", "dll", "so", "dylib", "bin",
  "dat", "img", "wasm", "o", "a", "class", "pyc", "node",
  // certificates and keys that are safe to *locate* (never read here)
  "pem", "crt", "cer", "der", "p12", "pfx", "asc", "sig", "gpg",
] as const;

/** Realtime channels published with bb.realtime.publish(channel, payload). */
export const FS_CHANNEL = "fs";
export const JOB_CHANNEL = "job";

/** Hard listing cap; the panel shows a "truncated" banner past this. */
export const MAX_LIST_ENTRIES = 5000;
export const MAX_SEARCH_RESULTS = 500;
export const MAX_SEARCH_DEPTH = 8;
/** Directory that holds in-flight upload parts; always hidden from listings. */
export const STAGING_DIR_NAME = ".bb-file-manager";

export const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/u;
export const MIN_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Shared enums and schemas                                            */
/* ------------------------------------------------------------------ */

export const entryKindSchema = z.enum(["file", "directory", "symlink", "other"]);
export type EntryKind = z.infer<typeof entryKindSchema>;

export const archiveFormatSchema = z.enum([
  "zip",
  "tar",
  "tar.gz",
  "tar.bz2",
  "tar.xz",
  "7z",
]);
export type ArchiveFormat = z.infer<typeof archiveFormatSchema>;

export const sortFieldSchema = z.enum(["name", "size", "modified", "kind"]);
export const sortDirectionSchema = z.enum(["asc", "desc"]);
export const conflictPolicySchema = z.enum(["rename", "overwrite", "fail"]);

/**
 * Stable error codes. Handlers throw `Error` whose message is exactly
 * `"<code>: <human readable message>"`; the wire delivers it as
 * `{ code: "handler_error", message }`. The frontend splits on the first
 * ": " to recover the code (lib/errors.ts#parseRpcError).
 */
export const errorCodeSchema = z.enum([
  "invalid_path",
  "invalid_name",
  "path_escape",
  "not_found",
  "not_a_directory",
  "not_a_file",
  "exists",
  "not_empty",
  "permission_denied",
  "cross_device",
  "destination_inside_source",
  "unsupported_archive",
  "archive_failed",
  "upload_not_found",
  "upload_busy",
  "offset_mismatch",
  "size_mismatch",
  "no_space",
  "io_error",
  "unsupported",
]);
export type FileManagerErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * bb's `fileOpener` source descriptor, mirrored so the backend can validate it
 * (§10.2). `kind` decides what `path` is relative to.
 */
export const fileOpenerSourceSchema = z.strictObject({
  kind: z.enum(["host", "thread-storage", "workspace"]),
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  projectId: z.string().nullable(),
});
export type FileOpenerSourceInput = z.infer<typeof fileOpenerSourceSchema>;

/**
 * Why a thread's workspace folder cannot be opened (§10.3).
 *
 * Codes rather than sentences: the phrasing belongs to whichever control has
 * to say it, and the panel is the side that speaks English to the user. All
 * three are ordinary states of a healthy thread, not failures.
 */
export const threadWorkspaceReasonSchema = z.enum([
  // The thread runs without an environment at all.
  "no_environment",
  // The environment has no directory on disk: unprovisioned, or destroyed.
  "no_checkout",
  // The checkout is real, but not under the hard root, so §6 forbids it.
  "outside_root",
]);
export type ThreadWorkspaceReason = z.infer<typeof threadWorkspaceReasonSchema>;

/** One directory entry. `path` is always absolute and inside the hard root. */
export const entrySchema = z.strictObject({
  /** Base name as it appears on disk. */
  name: z.string(),
  /** Absolute path of the entry itself (the link, not its target). */
  path: z.string(),
  /** lstat-derived kind: a symlink is reported as "symlink", never resolved. */
  kind: entryKindSchema,
  /** For symlinks: kind of the resolved target, or null when unresolvable. */
  targetKind: entryKindSchema.nullable(),
  /** lstat size for files; 0 for directories; link length for symlinks. */
  sizeBytes: z.number(),
  modifiedAtMs: z.number(),
  isHidden: z.boolean(),
  isSymlink: z.boolean(),
  /** True when the symlink resolves outside the hard root. Not navigable. */
  escapesRoot: z.boolean(),
  /** True when the name matches a supported archive extension. */
  archiveFormat: archiveFormatSchema.nullable(),
});
export type FileEntry = z.infer<typeof entrySchema>;

export const preferencesSchema = z.strictObject({
  showHiddenFiles: z.boolean(),
  confirmOnDelete: z.boolean(),
  /**
   * Reopen the folder the panel was last in instead of `startFolder` (v0.4.0).
   *
   * It lives here rather than being read through `useSettings()` because the
   * panel decides *where to open* inside its bootstrap effect, in the same tick
   * it learns the root and before the first `listDir`. `getState` is the one
   * call that already delivers that tick; a second async source racing it would
   * either delay the first listing or open the start folder and jump a moment
   * later.
   */
  restoreLastFolder: z.boolean(),
  sortField: sortFieldSchema,
  sortDirection: sortDirectionSchema,
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const volumeSchema = z.strictObject({
  totalBytes: z.number(),
  freeBytes: z.number(),
});

/** Per-path outcome for batch mutations. */
export const batchResultSchema = z.strictObject({
  succeeded: z.array(z.string()),
  failed: z.array(
    z.strictObject({
      path: z.string(),
      code: errorCodeSchema,
      message: z.string(),
    }),
  ),
});

export const jobSchema = z.strictObject({
  jobId: z.string(),
  kind: z.literal("extract"),
  state: z.enum(["running", "done", "failed", "canceled"]),
  /** Short human label, e.g. 'Extracting "archive.tar.gz"'. */
  label: z.string(),
  startedAtMs: z.number(),
  finishedAtMs: z.number().nullable(),
  /** Bytes read from the archive so far; 0 when unknown. */
  processedBytes: z.number(),
  /** Archive size in bytes; 0 when unknown. */
  totalBytes: z.number(),
  /** Absolute destination directory once known. */
  resultPath: z.string().nullable(),
  errorCode: errorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

/** Payload of the `fs` realtime channel. */
export const fsSignalSchema = z.strictObject({
  /** Absolute directories whose contents changed. */
  paths: z.array(z.string()),
  reason: z.enum([
    "create",
    "delete",
    "rename",
    "move",
    "copy",
    "upload",
    "extract",
  ]),
});
export type FsSignal = z.infer<typeof fsSignalSchema>;

/* ------------------------------------------------------------------ */
/* Properties (§8.10)                                                  */
/* ------------------------------------------------------------------ */

/** Everything the Properties dialog shows about a single path. */
export const pathPropertiesSchema = z.strictObject({
  name: z.string(),
  /** Absolute path of the entry itself — the link, never its target. */
  path: z.string(),
  /** Containing directory; null for the hard root, which has no parent here. */
  parentPath: z.string().nullable(),
  /** lstat kind: a symlink is "symlink", and its target is `targetKind`. */
  kind: entryKindSchema,
  targetKind: entryKindSchema.nullable(),
  isSymlink: z.boolean(),
  /** True when a symlink resolves outside the hard root. Not navigable. */
  escapesRoot: z.boolean(),
  /** Raw link text as stored on disk; null for everything but a symlink. */
  linkTarget: z.string().nullable(),
  /** Resolved absolute target; null when it is broken or escapes the root. */
  linkTargetPath: z.string().nullable(),
  /**
   * lstat size: file bytes, symlink target length, or a directory's own inode
   * size — never the size of a directory's contents. That is `directorySize`.
   */
  sizeBytes: z.number(),
  modifiedAtMs: z.number(),
  /** Null on a filesystem that records no birth time (rather than 1970). */
  createdAtMs: z.number().nullable(),
  accessedAtMs: z.number(),
  /** Four octal digits, setuid/setgid/sticky included: "0644", "4755". */
  modeOctal: z.string(),
  /** The `ls -l` mode column, type character included: "drwxr-xr-x". */
  modeText: z.string(),
  ownerUid: z.number(),
  ownerGid: z.number(),
  /**
   * Owner's name, or null. Node has no getpwuid, so only the user bb itself
   * runs as can be named without a name-service lookup; every other owner —
   * and every group — is reported as a number, the way `ls -n` does it.
   */
  ownerName: z.string().nullable(),
  linkCount: z.number(),
  /** MIME type guessed from the extension; null when the name says nothing. */
  contentType: z.string().nullable(),
});
export type PathProperties = z.infer<typeof pathPropertiesSchema>;

/** Result of the bounded recursive walk behind "Calculate size". */
export const directorySizeSchema = z.strictObject({
  path: z.string(),
  /** Sum of the lstat sizes of regular files; symlinks add nothing. */
  sizeBytes: z.number(),
  fileCount: z.number().int(),
  directoryCount: z.number().int(),
  /** Entries the walk looked at, including the ones it skipped. */
  visitedEntries: z.number().int(),
  /** True when a limit stopped the walk: every count above is a lower bound. */
  partial: z.boolean(),
  /** Which limit stopped it; null when the walk saw the whole subtree. */
  stoppedBy: z.enum(["depth", "entries", "time"]).nullable(),
  elapsedMs: z.number(),
});
export type DirectorySize = z.infer<typeof directorySizeSchema>;

/* ------------------------------------------------------------------ */
/* RPC contract                                                        */
/* ------------------------------------------------------------------ */

export const fileManagerContract = defineRpcContract({
  /** Panel bootstrap: root, persisted preferences, capabilities. */
  getState: {
    input: z.null(),
    output: z.strictObject({
      root: z.string(),
      /** Absolute, validated start folder; falls back to root when invalid. */
      startFolder: z.string(),
      preferences: preferencesSchema,
      /** Server-preferred upload chunk size in bytes (from settings). */
      chunkSizeBytes: z.number().int(),
      maxListEntries: z.number().int(),
      /** Which extractors are present on this host. */
      archiveSupport: z.strictObject({
        zip: z.boolean(),
        tar: z.boolean(),
        sevenZip: z.boolean(),
      }),
      pluginVersion: z.string(),
      /**
       * The host bb itself runs on — the machine whose home folder is the root
       * (§8.2). The panel needs it to hand a file to bb's preview panel, which
       * addresses a live file by host id. Null when the server could not name
       * it, and then a double-click downloads as it did before 0.7.
       */
      primaryHostId: z.string().nullable(),
    }),
  },

  /** List one directory. Never recursive. */
  listDir: {
    input: z.strictObject({
      /** Absolute path, or a path relative to root. "" means root. */
      path: z.string(),
      showHidden: z.boolean().default(false),
    }),
    output: z.strictObject({
      path: z.string(),
      parentPath: z.string().nullable(),
      isRoot: z.boolean(),
      entries: z.array(entrySchema),
      /** True when the directory had more than MAX_LIST_ENTRIES entries. */
      truncated: z.boolean(),
      /** Entries present on disk before hidden filtering and truncation. */
      totalEntries: z.number().int(),
      /** How many entries the hidden filter removed. */
      hiddenCount: z.number().int(),
      /** False when the process cannot write into this directory. */
      writable: z.boolean(),
      volume: volumeSchema.nullable(),
    }),
  },

  /**
   * Everything the Properties dialog shows about one path (§8.10).
   *
   * One lstat, and it never looks below the path it was given: the final
   * component is not followed, so a symlink describes itself, and a directory
   * reports its own inode size rather than its contents.
   */
  pathProperties: {
    input: z.strictObject({ path: z.string() }),
    output: pathPropertiesSchema,
  },

  /**
   * Recursive size of one directory (§8.10).
   *
   * Separate from `pathProperties` because it can take seconds: the walk is
   * bounded by depth, entry count and wall clock, never follows a symlink, and
   * says `partial: true` instead of pretending the total is complete.
   */
  directorySize: {
    input: z.strictObject({ path: z.string() }),
    output: directorySizeSchema,
  },

  /** Stat a single path; used for deep links and after external changes. */
  statPath: {
    input: z.strictObject({ path: z.string() }),
    output: z.strictObject({
      entry: entrySchema,
      parentPath: z.string().nullable(),
    }),
  },

  /**
   * Where a file link points, and which folder to open for it (§10.2).
   *
   * The path comes from a `fileOpener`, so it is relative to whatever surface
   * produced it: a worktree, a thread's storage directory, or absolute for a
   * host path. A target that does not exist is not an error — the nearest
   * existing folder is still the useful answer, which is what an agent's glob
   * or a since-renamed file needs.
   */
  resolveFileLocation: {
    input: z.strictObject({
      path: z.string(),
      source: fileOpenerSourceSchema,
    }),
    output: z.strictObject({
      /** Folder to open: the target's own, or its nearest existing ancestor. */
      dirPath: z.string(),
      /** Absolute path the link named. May not exist. */
      absolutePath: z.string(),
      /** Base name of the target; "" when the link named a folder. */
      name: z.string(),
      exists: z.boolean(),
      isDirectory: z.boolean(),
      /** Filter text for a missing glob-ish name, else null. */
      matchHint: z.string().nullable(),
    }),
  },

  /**
   * The folder a thread's code lives in — its environment's checkout (§10.3).
   *
   * Answers, never refuses: a thread with no environment, an environment with
   * no checkout and a checkout outside the hard root are all states the panel
   * tab's toolbar has to render, so they come back as a `reason` instead of a
   * throw. Only a thread bb cannot answer for rejects.
   */
  threadWorkspace: {
    input: z.strictObject({ threadId: z.string().min(1) }),
    output: z.strictObject({
      /**
       * The realpath'ed checkout directory, non-null exactly when it is a real
       * directory on disk right now — including when it sits outside the root
       * and is therefore unopenable, so the panel can say *where* it is rather
       * than only that it cannot go.
       */
      path: z.string().nullable(),
      /** True only when `path` is the hard root or below it: §6's prefix test. */
      insideRoot: z.boolean(),
      /** Null exactly when the panel may open `path`; a code otherwise. */
      reason: threadWorkspaceReasonSchema.nullable(),
    }),
  },

  /** Depth-limited recursive name search below `path`. */
  searchDir: {
    input: z.strictObject({
      path: z.string(),
      /** Case-insensitive substring match on the entry name. */
      query: z.string().min(1),
      showHidden: z.boolean().default(false),
      maxDepth: z.number().int().min(1).max(MAX_SEARCH_DEPTH).default(4),
    }),
    output: z.strictObject({
      entries: z.array(entrySchema),
      truncated: z.boolean(),
    }),
  },

  createFolder: {
    input: z.strictObject({
      /** Parent directory. */
      path: z.string(),
      name: z.string().min(1),
    }),
    output: z.strictObject({ entry: entrySchema }),
  },

  renameEntry: {
    input: z.strictObject({
      path: z.string(),
      newName: z.string().min(1),
    }),
    output: z.strictObject({ entry: entrySchema }),
  },

  deleteEntries: {
    input: z.strictObject({
      paths: z.array(z.string()).min(1).max(1000),
      /** Required for non-empty directories; false fails with not_empty. */
      recursive: z.boolean().default(true),
    }),
    output: batchResultSchema,
  },

  moveEntries: {
    input: z.strictObject({
      paths: z.array(z.string()).min(1).max(1000),
      destinationDir: z.string(),
      conflict: conflictPolicySchema.default("fail"),
    }),
    output: batchResultSchema,
  },

  copyEntries: {
    input: z.strictObject({
      paths: z.array(z.string()).min(1).max(1000),
      destinationDir: z.string(),
      conflict: conflictPolicySchema.default("rename"),
    }),
    output: batchResultSchema,
  },

  /** Starts a background extraction; poll with jobStatus or listen on JOB_CHANNEL. */
  extractArchive: {
    input: z.strictObject({
      archivePath: z.string(),
      /** Defaults to the archive's own directory. */
      destinationDir: z.string().nullable().default(null),
      /** Extract into <dest>/<archive base name>/ instead of <dest>/. */
      createSubfolder: z.boolean().default(true),
      conflict: conflictPolicySchema.default("rename"),
    }),
    output: z.strictObject({ job: jobSchema }),
  },

  jobStatus: {
    input: z.strictObject({ jobId: z.string() }),
    output: z.strictObject({ job: jobSchema.nullable() }),
  },

  jobCancel: {
    input: z.strictObject({ jobId: z.string() }),
    output: z.strictObject({ job: jobSchema.nullable() }),
  },

  /**
   * Open (or resume) an upload session. Resume key is
   * (destination dir, file name, size, lastModifiedMs) — a repeat call with the
   * same tuple returns the existing session and its byte count.
   */
  uploadCreate: {
    input: z.strictObject({
      /** Destination directory (absolute or root-relative). */
      dirPath: z.string(),
      fileName: z.string().min(1),
      sizeBytes: z.number().int().min(0),
      lastModifiedMs: z.number().int().min(0).default(0),
      /**
       * For folder drops: POSIX sub-path under dirPath, e.g. "photos/2024".
       * Created on finish. "" for a plain file drop.
       */
      relativeDir: z.string().default(""),
    }),
    output: z.strictObject({
      uploadId: z.string(),
      /** Bytes already on disk — the client starts from this offset. */
      receivedBytes: z.number().int(),
      chunkSizeBytes: z.number().int(),
      resumed: z.boolean(),
    }),
  },

  uploadStatus: {
    input: z.strictObject({ uploadId: z.string() }),
    output: z.strictObject({
      uploadId: z.string(),
      receivedBytes: z.number().int(),
      sizeBytes: z.number().int(),
      dirPath: z.string(),
      fileName: z.string(),
    }),
  },

  /** Commits the staged part file into the destination directory. */
  uploadFinish: {
    input: z.strictObject({
      uploadId: z.string(),
      conflict: conflictPolicySchema.default("rename"),
    }),
    output: z.strictObject({ entry: entrySchema }),
  },

  /** Drops the session and its part file. */
  uploadAbort: {
    input: z.strictObject({ uploadId: z.string() }),
    output: z.strictObject({ ok: z.literal(true) }),
  },

  /**
   * Persists panel preferences. The frontend cannot write settings
   * (`useSettings()` is read-only), so this method proxies to
   * bb.sdk.plugins.updateSettings.
   */
  savePreferences: {
    input: z.strictObject({
      startFolder: z.string().optional(),
      showHiddenFiles: z.boolean().optional(),
      confirmOnDelete: z.boolean().optional(),
      sortField: sortFieldSchema.optional(),
      sortDirection: sortDirectionSchema.optional(),
      uploadChunkMiB: z.enum(["4", "8", "16", "32", "64"]).optional(),
    }),
    output: z.strictObject({
      startFolder: z.string(),
      preferences: preferencesSchema,
      chunkSizeBytes: z.number().int(),
    }),
  },
});

export type FileManagerContract = typeof fileManagerContract;
