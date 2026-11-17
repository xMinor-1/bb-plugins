// The plugin carries its own copy of the Hugeicons glyphs it uses instead of
// depending on @hugeicons/core-free-icons (see components/ui/hugeicons.ts).
// These checks pin that copy: every glyph recorded from the package is still
// here unchanged, nothing imports the package again, and no glyph is unused.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as vendored from "../components/ui/hugeicons";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(PLUGIN_DIR, "components", "ui", "hugeicons");
const PACKAGE = ["@hugeicons", "core-free-icons"].join("/");

const recorded = JSON.parse(
  readFileSync(join(PLUGIN_DIR, "components", "ui", "hugeicons.glyphs.json"), "utf8"),
) as { package: string; glyphs: Record<string, string> };

const glyphs = vendored as unknown as Record<string, unknown>;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", ".git"].includes(entry.name)) {
        sourceFiles(join(dir, entry.name), out);
      }
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const IMPORT_RE = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

function importsOf(file: string): Array<{ names: string[]; specifier: string }> {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(IMPORT_RE)].map((match) => ({
    names: match[1]
      .split(",")
      .map((part) => part.trim().replace(/^type\s+/, ""))
      .filter(Boolean)
      .map((part) => part.split(/\s+as\s+/)[0].trim()),
    specifier: match[2],
  }));
}

function isVendoredModule(file: string, specifier: string): boolean {
  if (specifier.startsWith("@/")) return join(PLUGIN_DIR, specifier.slice(2)) === MODULE_PATH;
  if (!specifier.startsWith(".")) return false;
  return resolve(dirname(file), specifier).replace(/\.(ts|js)$/, "") === MODULE_PATH;
}

describe("vendored Hugeicons glyphs", () => {
  it("keeps every glyph recorded from the package, unchanged", () => {
    const names = Object.keys(recorded.glyphs).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(glyphs).sort()).toEqual(names);
    for (const name of names) {
      const glyph = glyphs[name];
      expect(Array.isArray(glyph) && glyph.length > 0, name).toBe(true);
      const hash = createHash("sha256").update(JSON.stringify(glyph)).digest("hex");
      expect(hash, name).toBe(recorded.glyphs[name]);
    }
  });

  it("no longer imports or installs the icon package", () => {
    const offenders = sourceFiles(PLUGIN_DIR).filter((file) =>
      importsOf(file).some((entry) => entry.specifier === PACKAGE),
    );
    expect(offenders).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(PACKAGE);
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain(PACKAGE);
  });

  it("ships only glyphs the plugin imports", () => {
    const imported = new Set<string>();
    for (const file of sourceFiles(PLUGIN_DIR)) {
      for (const entry of importsOf(file)) {
        if (isVendoredModule(file, entry.specifier)) entry.names.forEach((name) => imported.add(name));
      }
    }
    expect([...imported].sort()).toEqual(Object.keys(glyphs).sort());
  });
});
