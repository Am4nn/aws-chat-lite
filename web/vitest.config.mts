import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // The real module throws outside a React Server Components build, and the tests import server modules directly.
    alias: { "server-only": "next/dist/compiled/server-only/empty.js" },
  },
  test: { include: ["*.test.ts", "{app,lib,components}/**/*.test.{ts,tsx}"], environment: "node" },
});
