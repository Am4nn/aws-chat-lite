import { defineConfig } from "vitest/config";

export default defineConfig({ resolve: { tsconfigPaths: true }, test: { include: ["*.test.ts", "{app,lib,components}/**/*.test.{ts,tsx}"], environment: "node" } });
