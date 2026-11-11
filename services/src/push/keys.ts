import { secretJson, type ReadSecret, type SecretFields } from "../lib/secrets.js";

export type PushKeys = { publicKey?: string; privateKey?: string; subject?: string };

/**
 * The VAPID key pair and contact that sign every push (RFC 8292), from a Secrets Manager secret read once per
 * container. Unlike the model keys there's no environment fallback: without the secret, push is simply off.
 */
export async function pushKeys(env: SecretFields = process.env, read?: ReadSecret): Promise<PushKeys> {
  if (!env.PUSH_KEYS_SECRET) return {};
  const s = await secretJson(env.PUSH_KEYS_SECRET, read, ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]);
  return { publicKey: s.VAPID_PUBLIC_KEY, privateKey: s.VAPID_PRIVATE_KEY, subject: s.VAPID_SUBJECT };
}
