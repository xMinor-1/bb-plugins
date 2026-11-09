// The macOS Keychain store against a stand-in for /usr/bin/security that keeps
// items in a JSON file and prints them as the real tool does: a plain ASCII
// password as is, any other as the hex of its bytes. `security -i` takes the
// command on stdin; the stand-in logs every argument list it was started with.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYCHAIN_CHANGED, keychainHex, keychainValue, openKeychainSecretStore } from "../src/host/secret-store";

const FAKE_SECURITY = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = __dirname;
const itemsFile = join(dir, "items.json");
appendFileSync(join(dir, "argv.log"), JSON.stringify(process.argv.slice(2)) + "\n");
const items = existsSync(itemsFile) ? JSON.parse(readFileSync(itemsFile, "utf8")) : {};
const save = () => writeFileSync(itemsFile, JSON.stringify(items));
const option = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
function tokens(line) {
  const out = []; let i = 0;
  while (i < line.length) {
    if (line[i] === " ") { i++; continue; }
    let word = "";
    if (line[i] === '"') { i++; while (i < line.length && line[i] !== '"') word += line[i++]; i++; }
    else while (i < line.length && line[i] !== " ") word += line[i++];
    out.push(word);
  }
  return out;
}
function command(args) {
  const key = option(args, "-s") + "/" + option(args, "-a");
  if (args[0] === "add-generic-password") {
    const hex = option(args, "-X");
    if (hex === undefined || !/^([0-9a-f]{2})+$/.test(hex)) return 1;
    if (items[key] !== undefined && !args.includes("-U")) return 45;
    items[key] = hex; save(); return 0;
  }
  if (args[0] === "find-generic-password") {
    if (items[key] === undefined) return 44;
    if (args.includes("-w")) {
      const bytes = Buffer.from(items[key], "hex");
      const plain = bytes.every((b) => b >= 0x20 && b < 0x7f);
      process.stdout.write((plain ? bytes.toString("latin1") : items[key]) + "\n");
    }
    return 0;
  }
  if (args[0] === "delete-generic-password") {
    if (items[key] === undefined) return 44;
    delete items[key]; save(); return 0;
  }
  return 2;
}
const argv = process.argv.slice(2);
if (argv[0] === "-i") {
  let code = 0;
  for (const line of readFileSync(0, "utf8").split("\n")) if (line.trim() !== "") code = command(tokens(line)) || code;
  process.exit(code);
}
process.exit(command(argv));
`;

let dir = "";
let security = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "keychain-store-"));
  security = join(dir, "security");
  await writeFile(security, FAKE_SECURITY);
  await chmod(security, 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = () => openKeychainSecretStore(security);
const argvLog = async () => (await readFile(join(dir, "argv.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

describe("macOS Keychain store", () => {
  const VALUES = [
    ["a login with a backslash", "DOMAIN\\user"],
    ["a space", "a b"],
    ["a double quote", 'a"b'],
    ["a single quote", "a'b"],
    ["Cyrillic letters", "пароль Пётр"],
    ["hex that is not UTF-8 text", "cafe1234"],
    ["a sign-in pair as JSON", JSON.stringify({ login: "DOMAIN\\user", password: 'p a"s\'s' })],
  ];
  for (const [what, value] of VALUES) {
    it(`keeps a value with ${what} unchanged`, async () => {
      const store = open();
      await store.set("one", value!);
      expect(await store.get("one")).toBe(value);
      expect(await store.has("one")).toBe(true);
      // Only the program and its options travel in arguments; the value goes on stdin.
      for (const line of await argvLog()) {
        expect(line).not.toContain(JSON.stringify(value).slice(1, -1));
        expect(line).not.toContain(keychainHex(value!));
      }
    });
  }

  it("replaces a value that is already there", async () => {
    const store = open();
    await store.set("one", "first");
    await store.set("one", "второй");
    expect(await store.get("one")).toBe("второй");
  });

  it("refuses an ASCII value that reads back as hex text, and keeps nothing", async () => {
    const store = open();
    // "d0b0d0b1" is how `security -w` would print "аб": the two cannot be told apart.
    await expect(store.set("one", "d0b0d0b1")).rejects.toThrow(KEYCHAIN_CHANGED);
    expect(await store.has("one")).toBe(false);
  });

  it("still refuses an empty value and line breaks", async () => {
    const store = open();
    await expect(store.set("one", "  ")).rejects.toThrow(/empty/);
    await expect(store.set("one", "a\nb")).rejects.toThrow(/line breaks/);
  });

  it("answers null for a missing item", async () => {
    expect(await open().get("absent")).toBeNull();
  });
});

describe("keychainValue", () => {
  it("decodes the hex `security` prints for non-ASCII values", () => {
    expect(keychainValue(`${keychainHex("пароль")}\n`)).toBe("пароль");
    expect(keychainValue(keychainHex("пароль").toUpperCase())).toBe("пароль");
  });
  it("leaves plain values and hex that is not UTF-8 text as they are", () => {
    expect(keychainValue("DOMAIN\\user\n")).toBe("DOMAIN\\user");
    expect(keychainValue("cafe1234")).toBe("cafe1234");
    expect(keychainValue("41424344")).toBe("41424344");
    expect(keychainValue("abc")).toBe("abc");
  });
});
