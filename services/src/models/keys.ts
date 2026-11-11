import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export type ModelKeys = { anthropicKey?: string; deepseekKey?: string; deepseekBaseUrl?: string };
type Source = Record<string, string | undefined>;

async function readSecretJson(name: string): Promise<Source> {
  const { SecretString } = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: name }));
  return JSON.parse(SecretString ?? "{}");
}

/** DeepSeek's Anthropic-compatible API lives under /anthropic, beside its OpenAI-style /v1. */
export function deepseekBaseUrl(base: string): string {
  const root = base.replace(/\/+$/, "").replace(/\/v1$/, "");
  return root.endsWith("/anthropic") ? root : `${root}/anthropic`;
}

let secret: Promise<Source> | undefined;

/**
 * The provider keys. Deployed Lambdas read them from a Secrets Manager secret, once per container, so a key never
 * sits in a Lambda's configuration; a local process with no secret reads its own environment.
 */
export async function modelKeys(env: Source = process.env, read = readSecretJson): Promise<ModelKeys> {
  const name = env.MODEL_KEYS_SECRET;
  const source = name
    ? await (secret ??= read(name).catch((e) => {
        secret = undefined;
        throw e;
      }))
    : env;
  return {
    anthropicKey: source.ANTHROPIC_API_KEY,
    deepseekKey: source.DEEPSEEK_API_KEY,
    deepseekBaseUrl: source.DEEPSEEK_BASE_URL && deepseekBaseUrl(source.DEEPSEEK_BASE_URL),
  };
}
