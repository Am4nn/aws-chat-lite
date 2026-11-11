import { defineConfig } from "vitest/config";
import integration from "./vitest.int.config.js";

// The load test runs against the deployed stack, like the integration tests, and takes minutes:
// npm -w services run test:load
export default defineConfig({
  test: { ...integration.test, include: ["src/**/*.load.test.ts"], testTimeout: 600_000, silent: false },
});
