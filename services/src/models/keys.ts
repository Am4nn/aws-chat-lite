import { secretJson, type ReadSecret, type SecretFields } from "../lib/secrets.js";

export type ModelKeys = { anthropicKey?: string; deepseekKey?: string; geminiKey?: string; deepseekBaseUrl: string };

/** DeepSeek's Anthropic-compatible API lives under /anthropic, beside its OpenAI-style /v1. */
export function deepseekBaseUrl(base: string): string {
  const root = base.replace(/\/+$/, "").replace(/\/v1$/, "");
  return root.endsWith("/anthropic") ? root : `${root}/anthropic`;
}

/**
 * The provider keys. Deployed Lambdas read them from a Secrets Manager secret, once per container, so a key never
 * sits in a Lambda's configuration; a local process with no secret reads its own environment.
 */
export async function modelKeys(env: SecretFields = process.env, read?: ReadSecret): Promise<ModelKeys> {
  const source = env.MODEL_KEYS_SECRET ? await secretJson(env.MODEL_KEYS_SECRET, read) : env;
  return {
    anthropicKey: source.ANTHROPIC_API_KEY,
    deepseekKey: source.DEEPSEEK_API_KEY,
    geminiKey: source.GEMINI_API_KEY,
    deepseekBaseUrl: deepseekBaseUrl(source.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"),
  };
}
