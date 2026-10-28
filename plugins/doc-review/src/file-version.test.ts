import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { fileVersion } from "./file-version";

it("detects edits and deletion without reading file contents", async () => {
  const temp = path.resolve("../../../../.tmp");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(path.join(temp, "doc-review-version-"));
  try {
    const file = path.join(root, "report.html");
    await writeFile(file, "x".repeat(3_000_000));
    const before = await fileVersion(file);
    expect(before).toMatch(/-s3000000$/);
    expect(await fileVersion(file)).toBe(before);
    await utimes(file, new Date(1000), new Date(2000));
    expect(await fileVersion(file)).not.toBe(before);
    expect(await fileVersion(root)).toBeNull();
    await rm(file);
    expect(await fileVersion(file)).toBeNull();
    await expect(fileVersion("relative.html")).rejects.toThrow("absolute");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
