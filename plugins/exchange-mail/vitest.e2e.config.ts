import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Needs EWS_STUB_URL, for example from `test/stub/run.sh`.
export default defineConfig({
  resolve: { alias: { "@": rootDir } },
  test: { include: ["test/**/*.e2e.test.ts"], testTimeout: 60_000, fileParallelism: false },
});
