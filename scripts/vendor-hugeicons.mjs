#!/usr/bin/env node
// Copies the Hugeicons glyphs a plugin imports into the plugin itself.
//
// @hugeicons/core-free-icons ships every free icon as its own file (16,000 to
// 24,000 files, up to 150 MB). bb installs a git plugin with `npm install
// --omit=dev` and bundles it on the user's machine, so each plugin that
// lists the package unpacks all of it, while the bundle keeps only a hundred
// or so glyphs. This script writes those glyphs into the plugin:
//
//   components/ui/hugeicons.ts              the glyph data, one export per icon
//   components/ui/hugeicons-LICENSE.md      the package's MIT notice
//   components/ui/hugeicons.glyphs.json     name -> sha256 of the data, for the
//                                           plugin's test that no glyph changed
//
// and points every `from "@hugeicons/core-free-icons"` import at the local
// module. Names are collected from imports of the package and of the local
// module, so adding an icon later is: import it from "./hugeicons", install
// the package without saving it, run this script again.
//
// Usage (from the repository root):
//   node scripts/vendor-hugeicons.mjs plugins/<name> [--package <dir>] [--check]
//
//   --package <dir>  the installed @hugeicons/core-free-icons to copy from
//                    (default: <plugin>/node_modules/@hugeicons/core-free-icons)
//   --check          write nothing; fail if the plugin's copy differs from
//                    the package or misses an imported icon

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE = "@hugeicons/core-free-icons";
const MODULE_DIR = join("components", "ui");
const MODULE_FILE = "hugeicons.ts";
const LICENSE_FILE = "hugeicons-LICENSE.md";
const GLYPHS_FILE = "hugeicons.glyphs.json";
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function fail(message) {
  console.error(`vendor-hugeicons: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { plugin: undefined, pkg: undefined, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--package") args.pkg = argv[(i += 1)];
    else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else if (args.plugin === undefined) args.plugin = arg;
    else fail(`unexpected argument ${arg}`);
  }
  if (args.plugin === undefined) {
    fail("usage: node scripts/vendor-hugeicons.mjs plugins/<name> [--package <dir>] [--check]");
  }
  return args;
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const IMPORT_RE = /import\s*(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/** Imported binding names (the name before `as`) of one import list. */
function importedNames(list) {
  return list
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map((part) => part.split(/\s+as\s+/)[0].trim());
}

/** Whether `specifier` in `file` points at the plugin's vendored module. */
function isLocalModule(specifier, file, pluginDir, modulePath) {
  const target = modulePath.replace(/\.ts$/, "");
  if (specifier.startsWith("@/")) return join(pluginDir, specifier.slice(2)) === target;
  if (!specifier.startsWith(".")) return false;
  return resolve(dirname(file), specifier).replace(/\.(ts|js)$/, "") === target;
}

function localSpecifier(file, modulePath) {
  let spec = relative(dirname(file), modulePath).replace(/\.ts$/, "").split(sep).join("/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return spec;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function literal(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`unexpected attribute value ${JSON.stringify(value)}`);
}

function element([tag, attrs]) {
  const props = Object.entries(attrs)
    .map(([key, value]) => `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${literal(value)}`)
    .join(", ");
  return `  [${JSON.stringify(tag)}, { ${props} }],`;
}

function glyphHash(glyph) {
  return createHash("sha256").update(JSON.stringify(glyph)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const pluginDir = resolve(args.plugin);
const pkgDir = resolve(args.pkg ?? join(pluginDir, "node_modules", PACKAGE));
const moduleDir = join(pluginDir, MODULE_DIR);
const modulePath = join(moduleDir, MODULE_FILE);
const licensePath = join(moduleDir, LICENSE_FILE);
const glyphsPath = join(moduleDir, GLYPHS_FILE);

if (!existsSync(join(pluginDir, "package.json"))) fail(`${args.plugin} is not a plugin directory`);
if (!existsSync(join(pkgDir, "package.json"))) {
  fail(`${PACKAGE} is not installed at ${pkgDir}; install it with npm install --no-save ${PACKAGE}@<version>`);
}
const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
if (pkgJson.name !== PACKAGE) fail(`${pkgDir} holds ${pkgJson.name}, not ${PACKAGE}`);
const icons = await import(pathToFileURL(join(pkgDir, "dist", "esm", "index.js")).href);

// Collect the names the plugin imports and the files to repoint.
const names = new Set();
const rewrites = [];
for (const file of sourceFiles(pluginDir)) {
  if (file === modulePath) continue;
  const text = readFileSync(file, "utf8");
  let rewritten = text;
  for (const match of text.matchAll(IMPORT_RE)) {
    const [, , list, specifier] = match;
    const fromPackage = specifier === PACKAGE;
    if (!fromPackage && !isLocalModule(specifier, file, pluginDir, modulePath)) continue;
    for (const name of importedNames(list)) names.add(name);
    if (fromPackage) {
      rewritten = rewritten.replace(match[0], match[0].replace(/["'][^"']+["']$/, `"${localSpecifier(file, modulePath)}"`));
    }
  }
  if (rewritten !== text) rewrites.push([file, rewritten]);
}
if (names.size === 0) fail(`no imports of ${PACKAGE} or ${MODULE_DIR}/${MODULE_FILE} in ${args.plugin}`);

const sorted = [...names].sort();
const missing = sorted.filter((name) => !Array.isArray(icons[name]));
if (missing.length > 0) fail(`${PACKAGE}@${pkgJson.version} has no ${missing.join(", ")}`);

// Emit each glyph once; a name the package exports as an alias of a glyph
// that is already emitted becomes an alias here too.
const emittedBy = new Map();
const body = [];
const glyphs = {};
for (const name of sorted) {
  const glyph = icons[name];
  glyphs[name] = glyphHash(glyph);
  const first = emittedBy.get(glyph);
  if (first !== undefined) {
    body.push(`export const ${name}: IconSvgElement = ${first};`, "");
    continue;
  }
  emittedBy.set(glyph, name);
  body.push(`export const ${name}: IconSvgElement = [`, ...glyph.map(element), "];", "");
}

const version = pkgJson.version;
const scriptFromPlugin = relative(pluginDir, fileURLToPath(import.meta.url))
  .split(sep)
  .join("/");
const header = [
  `// Hugeicons glyphs this plugin uses, copied from ${PACKAGE}@${version}`,
  `// (https://www.npmjs.com/package/${PACKAGE}, https://hugeicons.com), so`,
  "// installing the plugin no longer unpacks the whole icon package.",
  `// The icons are MIT licensed, copyright Hugeicons: see ./${LICENSE_FILE}.`,
  "//",
  "// Generated; do not edit by hand. To add an icon, import it from",
  '// "./hugeicons" and regenerate from the plugin directory:',
  `//   npm install --no-save ${PACKAGE}@${version}`,
  `//   node ${scriptFromPlugin} .`,
  'import type { IconSvgElement } from "@hugeicons/react";',
  "",
];
const moduleText = `${[...header, ...body].join("\n").trimEnd()}\n`;
const glyphsText = `${JSON.stringify({ package: `${PACKAGE}@${version}`, glyphs }, null, 2)}\n`;

const pkgLicense = join(pkgDir, "LICENSE.md");
let licenseText;
if (existsSync(pkgLicense)) licenseText = readFileSync(pkgLicense, "utf8");
else if (existsSync(licensePath)) licenseText = readFileSync(licensePath, "utf8");
else fail(`${PACKAGE}@${version} ships no LICENSE.md; put the MIT notice at ${relative(process.cwd(), licensePath)} first`);

if (args.check) {
  const problems = [];
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  if (read(modulePath) !== moduleText) problems.push(`${MODULE_FILE} differs from ${PACKAGE}@${version}`);
  if (read(glyphsPath) !== glyphsText) problems.push(`${GLYPHS_FILE} differs from ${PACKAGE}@${version}`);
  if (!existsSync(licensePath)) problems.push(`${LICENSE_FILE} is missing`);
  for (const [file] of rewrites) problems.push(`${relative(pluginDir, file)} still imports ${PACKAGE}`);
  if (problems.length > 0) fail(problems.join("\n"));
  console.log(`${args.plugin}: ${sorted.length} glyphs match ${PACKAGE}@${version}`);
} else {
  writeFileSync(modulePath, moduleText);
  writeFileSync(glyphsPath, glyphsText);
  writeFileSync(licensePath, licenseText);
  for (const [file, text] of rewrites) writeFileSync(file, text);
  console.log(
    `${args.plugin}: wrote ${sorted.length} glyphs from ${PACKAGE}@${version}, repointed ${rewrites.length} file(s)`,
  );
}
