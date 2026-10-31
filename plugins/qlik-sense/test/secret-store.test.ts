// has() answers without reading the password: the setup page asks it every few seconds.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeOfKind } from "../src/host/secret-store";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("password store has()", () => {
  it("follows save and clear in the file store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qlik-store-"));
    dirs.push(dir);
    const store = storeOfKind("file", dir);
    expect(await store.has()).toBe(false);
    await store.save("pässword");
    expect(await store.has()).toBe(true);
    await store.clear();
    expect(await store.has()).toBe(false);
  });

  it("does not count a DPAPI file that is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qlik-store-"));
    dirs.push(dir);
    expect(await storeOfKind("dpapi", dir).has()).toBe(false);
  });
});
