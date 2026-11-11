import { defineConfig } from "vitest/config";

// Synthesizing a stack bundles every Lambda with esbuild, which takes about a minute on a busy machine and a lot of
// memory. Running test files in parallel made concurrent esbuild processes crash a worker, so files run one at a time.
export default defineConfig({ test: { testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false } });
