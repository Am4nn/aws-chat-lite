import { defineConfig } from "vitest/config";

// Unit tests only: the integration tests (*.int.test.ts) need DynamoDB on Floci and run with npm run test:int.
export default defineConfig({ test: { exclude: ["**/node_modules/**", "**/*.int.test.ts"] } });
