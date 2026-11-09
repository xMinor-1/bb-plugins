// The OpenCode resolver reads the Keychain itself, so it must decode the hex
// `security -w` prints for non-ASCII values the same way the store does.
import { describe, expect, it } from "vitest";
import { resolverSource } from "../src/host/opencode-resolver";
import { keychainHex, keychainValue } from "../src/secret-store";

const RESOLVER = { providers: {}, store: { kind: "keychain", label: "macOS Keychain", directory: null } } as never;

function resolverKeychainValue(): (printed: string) => string {
  const source = resolverSource(RESOLVER);
  const start = source.indexOf("function keychainValue(printed) {");
  const end = source.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(0);
  return new Function(`${source.slice(start, end + 2)}; return keychainValue;`)() as (printed: string) => string;
}

describe("the resolver's Keychain reading", () => {
  const generated = resolverKeychainValue();
  for (const printed of [`${keychainHex("пароль")}\n`, "DOMAIN\\user\n", "a b", "cafe1234", "41424344", keychainHex("ключ").toUpperCase(), ""]) {
    it(`reads ${JSON.stringify(printed)} as the store does`, () => {
      expect(generated(printed)).toBe(keychainValue(printed));
    });
  }
  it("decodes Cyrillic", () => {
    expect(generated(keychainHex("пароль"))).toBe("пароль");
  });
});
