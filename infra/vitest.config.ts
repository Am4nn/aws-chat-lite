import { defineConfig } from "vitest/config";

// Synthesizing a stack bundles every Lambda with esbuild, which takes several seconds and a lot of memory.
// Running test files in parallel made concurrent esbuild processes crash a worker, so files run one at a time.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false } });
