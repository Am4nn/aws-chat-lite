import { defineConfig } from "vitest/config";

export default defineConfig({ resolve: { tsconfigPaths: true }, test: { include: ["app/**/*.test.ts", "lib/**/*.test.ts", "components/**/*.test.ts", "components/**/*.test.tsx"], environment: "node" } });
