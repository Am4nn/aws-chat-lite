import { defineConfig } from "vitest/config";

// Synthesizing the core stack takes a few seconds even without bundling, longer with every test file at once.
// aws-cdk-lib validates each synthesized template with a WebAssembly engine, and on a busy machine many workers
// starting it at once crash it ("RuntimeError: unreachable"). A few workers keep that validation on and stable.
export default defineConfig({ test: { testTimeout: 30_000, maxWorkers: 4 } });
