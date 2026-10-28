import { stat } from "node:fs/promises";
import path from "node:path";

/** A metadata token: no file contents are read, including for inline images. */
export async function fileVersion(filePath: string): Promise<string | null> {
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) throw new Error("Expected an absolute file path.");
  try {
    const info = await stat(filePath);
    return info.isFile() ? `m${info.mtimeMs}-c${info.ctimeMs}-s${info.size}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}
