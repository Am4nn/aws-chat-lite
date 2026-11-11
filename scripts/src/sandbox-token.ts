import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_PATH = fileURLToPath(new URL("../../.secrets/sandbox-token", import.meta.url));

/**
 * The secret the local run Lambda sends to the sandbox server. It is made once and kept in .secrets/ (ignored by git),
 * because the deploy bakes it into the Lambda's environment and the server must still match it after a restart. An
 * empty file gets a new token: an empty one would leave the server refusing to start and the Lambda without one.
 */
export function localSandboxToken(path = TOKEN_PATH): string {
  const kept = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (kept) return kept;
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}
