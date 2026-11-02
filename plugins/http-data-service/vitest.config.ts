import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Unit tests need no service: the host suite talks to a local HTTP server.
export default defineConfig({
  resolve: { alias: { "@": rootDir } },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20_000,
  },
});
