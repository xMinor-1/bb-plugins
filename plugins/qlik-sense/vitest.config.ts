import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Unit tests need no Qlik engine. The engine suite runs with `npm run test:e2e`.
export default defineConfig({
  resolve: { alias: { "@": rootDir } },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.e2e.test.ts", "node_modules/**", "dist/**"],
    testTimeout: 20_000,
  },
});
