import { defineConfig } from "vitest/config";

// Unit tests only; integration tests (*.int.test.ts) need Floci: npm run test:int
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/*.int.test.ts"], env: { LOG_LEVEL: "SILENT" } },
});
