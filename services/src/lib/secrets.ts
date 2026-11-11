import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export type SecretFields = Record<string, string | undefined>;
export type ReadSecret = (name: string) => Promise<string | undefined>;

const readSecret: ReadSecret = async (name) => {
  return (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: name }))).SecretString;
};

const cache = new Map<string, Promise<SecretFields>>();

/**
 * A JSON secret's fields, read once per container so a key never sits in a Lambda's configuration and warm
 * invocations don't pay for the call. A failed read isn't cached, so the next invocation tries again.
 */
export function secretJson(name: string, read: ReadSecret = readSecret): Promise<SecretFields> {
  let fields = cache.get(name);
  if (!fields) {
    fields = read(name).then((text) => {
      // Node's JSON.parse error quotes the text it choked on, which here would be part of a key.
      try {
        return JSON.parse(text ?? "{}") as SecretFields;
      } catch {
        throw new Error(`The secret ${name} isn't valid JSON.`);
      }
    });
    fields.catch(() => cache.delete(name));
    cache.set(name, fields);
  }
  return fields;
}
