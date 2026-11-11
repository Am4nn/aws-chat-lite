import { parseEnv } from "node:util";

export const MODEL_KEY_NAMES = ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "GEMINI_API_KEY"] as const;
export const TOOL_KEY_NAMES = ["TAVILY_API_KEY", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY"] as const;
export const PUSH_KEY_NAMES = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

/** The named values from the text of .env; only these leave the file. */
function pick(envText: string, names: readonly string[]): Record<string, string> {
  const env = parseEnv(envText);
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`.env is missing ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, env[name]!]));
}

/** The model keys secret's JSON. */
export function modelKeysSecret(envText: string): string {
  return JSON.stringify(pick(envText, MODEL_KEY_NAMES));
}

/** The push keys secret's JSON. */
export function pushKeysSecret(envText: string): string {
  return JSON.stringify(pick(envText, PUSH_KEY_NAMES));
}

/**
 * The tool keys secret's JSON. GitHub hands out the App's private key as a .pem file, so .env names the file and the
 * key itself goes into the secret. Errors name the setting, never the file's contents.
 */
export function toolKeysSecret(envText: string, readFile: (path: string) => string): string {
  const fromEnv = TOOL_KEY_NAMES.map((name) => (name === "GITHUB_APP_PRIVATE_KEY" ? "GITHUB_APP_PRIVATE_KEY_PATH" : name));
  const { GITHUB_APP_PRIVATE_KEY_PATH: path, ...keys } = pick(envText, fromEnv);
  let pem: string;
  try {
    pem = readFile(path!);
  } catch {
    throw new Error(`Can't read the file at GITHUB_APP_PRIVATE_KEY_PATH (${path}).`);
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) throw new Error("The file at GITHUB_APP_PRIVATE_KEY_PATH isn't a PEM private key.");
  return JSON.stringify({ ...keys, GITHUB_APP_PRIVATE_KEY: pem });
}
