import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_PATH = fileURLToPath(new URL("../../.secrets/sandbox-token", import.meta.url));

/**
 * The secret the local run Lambda sends to the sandbox server. It is made once and kept in .secrets/ (ignored by git),
 * because the deploy bakes it into the Lambda's environment and the server must still match it after a restart.
 */
export function localSandboxToken(path = TOKEN_PATH): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}
