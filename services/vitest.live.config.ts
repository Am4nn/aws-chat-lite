import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The real-model suite calls the providers with the keys in the repo's gitignored .env. It is opt-in, and costs
// money: REAL_MODELS=1 npm -w services run test:live
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Not silent: the suite's job includes printing what each call cost, and vitest hides passing tests' logs in some
// terminals.
export default defineConfig({ test: { include: ["src/**/*.live.test.ts"], testTimeout: 180_000, silent: false } });
