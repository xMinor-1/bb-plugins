import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Needs a Chromium-based browser on this machine (Google Chrome, Edge or Chromium).
export default defineConfig({
  resolve: { alias: { "@": rootDir } },
  test: { include: ["test/**/*.e2e.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
