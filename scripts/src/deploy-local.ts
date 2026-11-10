import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { localEnv, useLocalEnv } from "./env.js";
import { assertOurFlociUp } from "./floci-owner.js";
import { cleanStaleStacks } from "./stale.js";

export const infraDir = fileURLToPath(new URL("../../infra/", import.meta.url));

/** Run the CDK CLI inside infra/ (default: with Floci env vars). Throws on non-zero exit. */
export function cdk(args: string[], env: NodeJS.ProcessEnv = localEnv(process.env)): void {
  // Run the CLI through node directly: no shell, so the space in the path is safe.
  const cdkBin = createRequire(`${infraDir}package.json`).resolve("aws-cdk/bin/cdk");
  const res = spawnSync(process.execPath, [cdkBin, ...args], { cwd: infraDir, env, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`cdk ${args[0]} failed (exit ${res.status})`);
}

export function readOutputs(stack: string, file = "outputs-local.json"): Record<string, string> {
  const all = JSON.parse(readFileSync(`${infraDir}cdk.out/${file}`, "utf8"));
  return all[stack] ?? {};
}

/** Floci answers execute-api hosts as <apiId>.execute-api.localhost.floci.io:4566 (public DNS → 127.0.0.1). */
export function localApiUrl(awsUrl: string): string {
  const m = /^(?:https?|wss?):\/\/([a-z0-9]+)\.execute-api\./.exec(awsUrl);
  if (!m) throw new Error(`not an execute-api URL: ${awsUrl}`);
  return `http://${m[1]}.execute-api.localhost.floci.io:4566`;
}

export async function deployLocalStack(): Promise<Record<string, string>> {
  cdk(["deploy", "cl-local-core", "-c", "stage=local", "--require-approval", "never", "--outputs-file", "cdk.out/outputs-local.json"]);
  return readOutputs("cl-local-core");
}

async function main() {
  await assertOurFlociUp();
  useLocalEnv();
  const stale = await cleanStaleStacks();
  if (stale.length) console.log(`Floci was reset; removed stale stack records: ${stale.join(", ")}`);
  cdk(["bootstrap", "aws://000000000000/us-east-1", "-c", "stage=local"]);
  const out = await deployLocalStack();
  console.log(`\nTry: curl ${localApiUrl(out.ApiUrl)}/health\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
