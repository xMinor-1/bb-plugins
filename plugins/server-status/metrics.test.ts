import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMacMemory, parseMacSwap } from "./mac-metrics.ts";
test("excludes file cache, counts physical compressor rather than stored pages", () => {
  const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Anonymous pages: 100.
Pages purgeable: 10.
Pages wired down: 20.
Pages occupied by compressor: 30.
Pages stored in compressor: 90.
File-backed pages: 200.`;
  assert.equal(parseMacMemory(vm, 1000 * 16384).usedBytes, 140 * 16384);
});
test("rejects missing counters instead of showing healthy zero", () => {
  assert.throws(() => parseMacMemory("Pages free: 123.", 100));
});
test("reads dynamically allocated macOS swap", () => {
  const s = parseMacSwap(
    "total = 1024.00M  used = 42.56M  free = 981.44M (encrypted)",
  );
  assert.equal(s.totalBytes, 1024 * 1024 * 1024);
  assert.equal(s.usedBytes, 42.56 * 1024 * 1024);
  assert.throws(() => parseMacSwap("unavailable"));
});
