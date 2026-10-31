import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Unit tests run against in-process stubs: no network, no bb, no OpenCode.
export default defineConfig({
  resolve: { alias: { "@": rootDir } },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 20_000,
  },
});
