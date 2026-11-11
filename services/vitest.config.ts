import { defineConfig } from "vitest/config";

// Unit tests only: the integration tests (*.int.test.ts) need DynamoDB on Floci and run with npm run test:int; the
// real-model (*.live.test.ts) and load (*.load.test.ts) suites have their own commands.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/*.int.test.ts", "**/*.live.test.ts", "**/*.load.test.ts"] },
});
