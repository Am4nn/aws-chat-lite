import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { localEnv } from "./env.js";

const infraDir = fileURLToPath(new URL("../../infra/", import.meta.url));

/** Run the CDK CLI inside infra/ (default: with Floci env vars). Throws on non-zero exit. */
export function cdk(args: string[], env: NodeJS.ProcessEnv = localEnv(process.env)): void {
  // Run the CLI through node directly: no shell, so the space in the path is safe.
  const cdkBin = createRequire(`${infraDir}package.json`).resolve("aws-cdk/bin/cdk");
  const res = spawnSync(process.execPath, [cdkBin, ...args], { cwd: infraDir, env, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`cdk ${args[0]} failed (exit ${res.status})`);
}

/** A stack's outputs, as its last deploy wrote them under infra/cdk.out. */
export function readOutputs(stack: string, file = "outputs-local.json"): Record<string, string> {
  const all = JSON.parse(readFileSync(`${infraDir}cdk.out/${file}`, "utf8"));
  return all[stack] ?? {};
}
