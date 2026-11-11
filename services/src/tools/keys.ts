import { secretJson, type ReadSecret, type SecretFields } from "../lib/secrets.js";
import type { ToolKeys } from "./types.js";

/** The tool keys: from the Secrets Manager secret when deployed, from a local process's own environment otherwise. */
export async function toolKeys(env: SecretFields = process.env, read?: ReadSecret): Promise<ToolKeys> {
  const source = env.TOOL_KEYS_SECRET ? await secretJson(env.TOOL_KEYS_SECRET, read) : env;
  return {
    tavilyKey: source.TAVILY_API_KEY,
    githubAppId: source.GITHUB_APP_ID,
    githubAppSlug: source.GITHUB_APP_SLUG,
    githubPrivateKey: source.GITHUB_APP_PRIVATE_KEY,
  };
}
