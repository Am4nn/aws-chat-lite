import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export type SecretFields = Record<string, string | undefined>;
export type ReadSecret = (name: string) => Promise<string | undefined>;

const readSecret: ReadSecret = async (name) => {
  return (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: name }))).SecretString;
};

const cache = new Map<string, Promise<string>>();

/**
 * A secret's text, read once per container so a key never sits in a Lambda's configuration and warm invocations
 * don't pay for the call. A failed read isn't cached, so the next invocation tries again.
 */
export function secretText(name: string, read: ReadSecret = readSecret): Promise<string> {
  let text = cache.get(name);
  if (!text) {
    text = read(name).then((value) => {
      if (value === undefined) throw new Error(`The secret ${name} has no text.`);
      return value;
    });
    text.catch(() => cache.delete(name));
    cache.set(name, text);
  }
  return text;
}

/**
 * A JSON secret's fields. One that isn't JSON yet, or lacks a `needed` field, is still being set up, so it isn't kept:
 * the next call reads it again, and setting it takes effect without waiting for warm containers to recycle.
 */
export async function secretJson(name: string, read: ReadSecret = readSecret, needed: readonly string[] = []): Promise<SecretFields> {
  const text = await secretText(name, read);
  let fields: SecretFields;
  // Node's JSON.parse error quotes the text it choked on, which here would be part of a key.
  try {
    fields = JSON.parse(text) as SecretFields;
  } catch {
    cache.delete(name);
    throw new Error(`The secret ${name} isn't valid JSON.`);
  }
  if (needed.some((field) => !fields[field])) cache.delete(name);
  return fields;
}
