import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { secretText, type ReadSecret } from "../../lib/secrets.js";

export class SealError extends Error {}

const TAG_BYTES = 16;

/**
 * AES-256-GCM. The aad (the room and connection) is authenticated but not stored, so a blob copied to another room's
 * item won't open there.
 */
export function seal(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${data.toString("base64url")}`;
}

export function unseal(key: Buffer, sealed: string, aad: string): string {
  const [version, iv, encoded] = sealed.split(".");
  if (version !== "v1" || !iv || !encoded) throw new SealError("That isn't a sealed value.");
  const data = Buffer.from(encoded, "base64url");
  try {
    // A fixed tag length: without it, Node also accepts a truncated tag, which is far easier to forge.
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES })
      .setAAD(Buffer.from(aad))
      .setAuthTag(data.subarray(-TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(0, -TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new SealError("The sealed value won't open.");
  }
}

/** The key for room tokens, derived from a generated secret so the secret's text never has to be key-shaped. */
export async function tokenKey(env: Record<string, string | undefined> = process.env, read?: ReadSecret): Promise<Buffer> {
  if (!env.TOKEN_KEY_SECRET) throw new Error("TOKEN_KEY_SECRET isn't set.");
  const secret = await secretText(env.TOKEN_KEY_SECRET, read);
  return Buffer.from(hkdfSync("sha256", secret, "", "chat-lite mcp tokens", 32));
}
