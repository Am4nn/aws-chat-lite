import { defineConfig } from "vitest/config";

// Synthesizing the core stack takes a few seconds even without bundling, longer with every test file at once.
export default defineConfig({ test: { testTimeout: 30_000 } });
