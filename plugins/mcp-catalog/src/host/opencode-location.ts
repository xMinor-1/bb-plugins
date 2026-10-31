// Copied from plugins/fleet-kit/src/host/opencode-location.ts (commit ccc161e), itself a copy of qlik-sense's.
// Verbatim copy.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { opencodeConfigDirSchema } from "../shared/settings.js";

export interface OpenCodeLocationOptions {
  opencodeConfigDir?: string;
  environment: NodeJS.ProcessEnv;
  /** Host-local defaults; injectable for cross-platform path tests. */
  userHome?: string;
  platform?: "win32" | "posix";
}

/** Match OpenCode 2.2.5: explicit setting, then ACP env, then XDG/home.
 * No files are read; provider plugins and credentials are never inspected. */
export function resolveOpenCodeLocation(options: OpenCodeLocationOptions) {
  const paths = (options.platform ?? (process.platform === "win32" ? "win32" : "posix")) === "win32" ? win32 : posix;
  // win32.isAbsolute also accepts a root on the current drive. That drive can
  // differ between the writer and the project's child process.
  const fullyAbsolute = (value: string) => paths === win32
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(value)
    : paths.isAbsolute(value);
  const setting = opencodeConfigDirSchema.parse(options.opencodeConfigDir ?? "");
  const fromEnvironment = options.environment.OPENCODE_CONFIG_DIR;
  let directory = setting || fromEnvironment;
  if (!directory) {
    const root = options.environment.XDG_CONFIG_HOME || paths.join(options.userHome ?? homedir(), ".config");
    if (!fullyAbsolute(root)) throw new Error("OpenCode configuration root must be an absolute directory.");
    directory = paths.join(root, "opencode");
  }
  if (!fullyAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) throw new Error("OpenCode configuration directory must be fully absolute and contain no control characters.");
  directory = paths.normalize(directory);
  return {
    directory,
    configFile: paths.join(directory, "opencode.json"),
    environment: { ...options.environment, OPENCODE_CONFIG_DIR: directory },
  };
}
