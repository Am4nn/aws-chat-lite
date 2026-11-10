import { defineConfig } from "vitest/config";

// CDK synth bundles each Lambda with esbuild; the first synth in a file can take > 5 s.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
