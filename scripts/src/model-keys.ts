import { parseEnv } from "node:util";

export const MODEL_KEY_NAMES = ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;

/** The model keys secret's JSON, taken from the text of .env; only these three keys leave the file. */
export function modelKeysSecret(envText: string): string {
  const env = parseEnv(envText);
  const missing = MODEL_KEY_NAMES.filter((name) => !env[name]);
  if (missing.length) throw new Error(`.env is missing ${missing.join(", ")}`);
  return JSON.stringify(Object.fromEntries(MODEL_KEY_NAMES.map((name) => [name, env[name]])));
}
