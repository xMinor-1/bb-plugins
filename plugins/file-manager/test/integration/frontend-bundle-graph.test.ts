// The frontend bundle graph must not need @get-bb/plugin-sdk at build time.
//
// app.tsx imports contract.ts for its shared constants, so anything contract.ts
// imports as a *value* is pulled into the panel bundle. bb only shims the
// "@get-bb/plugin-sdk/app" subpath, and a catalog install runs
// `npm install --omit=dev` before bundling — a value import of the bare SDK
// specifier therefore breaks every install from the marketplace, while moving
// the SDK into `dependencies` makes `bb plugin types --check` fail instead.
// Type-only imports are erased at build time and are fine.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = join(import.meta.dirname, "..", "..");
const read = (relativePath: string): string =>
  readFileSync(join(pluginRoot, relativePath), "utf8");

/** Matches `import … from "@get-bb/plugin-sdk"` but not `import type …`. */
const sdkValueImport =
  /import\s+(?!type\s)[^;]*?from\s*["']@get-bb\/plugin-sdk["']/;

describe("frontend bundle graph", () => {
  it("contract.ts imports the SDK for types only", () => {
    const source = read("contract.ts");
    expect(source).toContain("@get-bb/plugin-sdk");
    expect(sdkValueImport.test(source)).toBe(false);
  });

  it("keeps the SDK out of runtime dependencies", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["@get-bb/plugin-sdk"]).toBeUndefined();
    expect(manifest.devDependencies?.["@get-bb/plugin-sdk"]).toBeDefined();
  });

  it("no panel-side module imports the SDK as a value", () => {
    for (const file of ["app.tsx", "lib/fm-rpc.ts", "lib/start-folder.ts"]) {
      expect(sdkValueImport.test(read(file))).toBe(false);
    }
  });
});
