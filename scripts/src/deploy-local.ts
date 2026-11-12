import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cdk, readOutputs } from "./cdk.js";
import { run } from "./cli.js";
import { flociHost, localEnv, useLocalEnv } from "./env.js";
import { assertOurFlociUp } from "./floci-owner.js";
import { cleanStaleStacks } from "./stale.js";
import { devEnvFile } from "./dev-env.js";
import { MODEL_KEY_NAMES, PUSH_KEY_NAMES, TOOL_KEY_NAMES, modelKeysSecret, pushKeysSecret, pushPublicKeySecret, toolKeysSecret } from "./keys-secrets.js";
import { localSandboxToken } from "./sandbox-token.js";

const webEnvPath = fileURLToPath(new URL("../../web/.env.development.local", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoEnvPath = `${repoRoot}.env`;

async function putSecret(name: string, value: string, keyNames: readonly string[], what: string) {
  await new SecretsManagerClient({}).send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
  console.log(`${what} keys stored in Floci: ${keyNames.join(", ")}`);
}

/**
 * `--live-models` makes the run Lambda call the real providers, `--live-tools` the real GitHub App and Tavily, and
 * `--live-push` the real push services. The keys go from .env straight into Floci's secrets after the deploy, never
 * through CDK, so they stay out of the template and cdk.out. They are read before the deploy, so a missing one fails
 * fast. The push keys are stored whenever .env has them: they cost nothing, and a browser needs the public one to
 * subscribe even while sends are fake.
 */
async function main() {
  const liveModels = process.argv.includes("--live-models");
  const liveTools = process.argv.includes("--live-tools");
  const livePush = process.argv.includes("--live-push");
  const envText = existsSync(repoEnvPath) ? readFileSync(repoEnvPath, "utf8") : "";
  const modelKeys = liveModels ? modelKeysSecret(envText) : undefined;
  const toolKeys = liveTools ? toolKeysSecret(envText, (path) => readFileSync(resolve(repoRoot, path), "utf8")) : undefined;
  let pushKeys: string | undefined;
  try {
    pushKeys = pushKeysSecret(envText);
  } catch (e) {
    if (livePush) throw e;
  }
  await assertOurFlociUp();
  useLocalEnv();
  const stale = await cleanStaleStacks();
  if (stale.length) console.log(`Floci was reset; removed stale stack records: ${stale.join(", ")}`);
  cdk(["bootstrap", "aws://000000000000/us-east-1", "-c", "stage=local"]);
  const cdkEnv = {
    ...localEnv(process.env), MODEL_GATEWAY: liveModels ? "live" : "fake", TOOL_MODE: liveTools ? "live" : "fake",
    PUSH_MODE: livePush ? "live" : "fake", SANDBOX_TOKEN: localSandboxToken(),
  };
  cdk(["deploy", "cl-local-core", "-c", "stage=local", "--require-approval", "never", "--outputs-file", "cdk.out/outputs-local.json"], cdkEnv);
  if (modelKeys) await putSecret("cl-local-model-keys", modelKeys, MODEL_KEY_NAMES, "model");
  if (toolKeys) await putSecret("cl-local-tool-keys", toolKeys, TOOL_KEY_NAMES, "tool");
  if (pushKeys) {
    await putSecret("cl-local-push-keys", pushKeys, PUSH_KEY_NAMES, "push");
    await putSecret("cl-local-push-public-key", pushPublicKeySecret(envText), ["VAPID_PUBLIC_KEY"], "push public");
  } else console.log("push keys not in .env: notifications are off locally");
  const out = readOutputs("cl-local-core");
  const api = `http://${flociHost(out.ApiUrl)}`;
  writeFileSync(webEnvPath, devEnvFile({ apiUrl: api, userPoolClientId: out.UserPoolClientId }));
  console.log(`\nAPI: ${api}  (try: curl ${api}/health)\nWrote web/.env.development.local. Next: npm run dev (the web app and the run stream)\n`);
}

run(main);
