#!/usr/bin/env node
// Lists English strings of bb's settings and first-run screens that the dictionary does not cover yet.
// Run it after a bb update; translate the output and add it to src/dictionary/settings.json, or add a string
// that should stay English to scripts/keep-english.json.
//
//   node scripts/missing-strings.mjs [path to bb-app/app/dist/assets]
//
// Without a path it takes the newest bb under ~/.bb/app-versions. It reads bb's built files, so it sees
// strings of screens nobody has opened yet, but not the settings that plugins declare themselves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_FILES = /^(SettingsView|MachineSettingsView|ProjectDetailSettingsView|ProjectsSettingsSection|settings-[a-z-]+|SettingsSidebar|OnboardingFlow)-.*\.js$/;

function newestAssets() {
  const root = path.join(os.homedir(), ".bb", "app-versions");
  const versions = fs.readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const version of versions.reverse()) {
    const dir = path.join(root, version, "node_modules", "bb-app", "app", "dist", "assets");
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`no bb build under ${root}`);
}

/** Template literals that read like interface text: words with spaces or a capitalized word, no code or CSS. */
function uiStrings(source) {
  const out = new Set();
  for (const [, raw] of source.matchAll(/`([^`$\\]{2,300})`/g)) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!/^[A-Z][a-z]|^[a-z]+ [a-z]+ /.test(text)) continue;
    if (/[{}();=<>]|=>|\b(var|let|const|function|return)\b/.test(text)) continue;
    if (/(^|\s)[a-z]+(-[a-z0-9[\]./:%]+)+(\s|$)/.test(text) && !/[.?!]$/.test(text)) continue; // CSS classes
    if (!/^[A-Z][a-z]+$/.test(text) && !text.includes(" ")) continue;
    out.add(text);
  }
  return out;
}

async function loadDictionary() {
  const dir = path.join(here, "..", "src", "dictionary");
  const exact = {};
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    Object.assign(exact, JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
  }
  // The patterns live in TypeScript; their sources are read as text so this script needs no build step.
  const index = fs.readFileSync(path.join(dir, "index.ts"), "utf8");
  const patterns = [...index.matchAll(/\[\/(.+?)\/,\s*"/g)].map(([, source]) => new RegExp(source));
  return { exact, patterns };
}

const assets = process.argv[2] ?? newestAssets();
const { exact, patterns } = await loadDictionary();
// Strings checked once and left English on purpose: key names, icon and color identifiers, program names.
const keepEnglish = new Set(JSON.parse(fs.readFileSync(path.join(here, "keep-english.json"), "utf8")));
const missing = new Set();
for (const file of fs.readdirSync(assets).filter((name) => SCREEN_FILES.test(name))) {
  for (const text of uiStrings(fs.readFileSync(path.join(assets, file), "utf8"))) {
    if (!(text in exact) && !keepEnglish.has(text) && !patterns.some((pattern) => pattern.test(text))) missing.add(text);
  }
}
const list = [...missing].sort((a, b) => a.localeCompare(b));
console.log(list.join("\n"));
console.error(`${list.length} strings without a translation in ${assets}`);
