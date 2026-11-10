export const FLOCI_ENDPOINT = "http://localhost:4566";

/** Env vars that point the AWS CLI, SDK and CDK at Floci. */
export function flociEnv(): Record<string, string> {
  return {
    AWS_ENDPOINT_URL: FLOCI_ENDPOINT,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
  };
}

/** Settings that would make the SDK/CDK use real credentials instead of Floci's test keys. */
const REAL_AWS_VARS = ["AWS_PROFILE", "AWS_SESSION_TOKEN", "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS"];

/** `base` with real-AWS credential settings removed and Floci's env applied. */
export function localEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of REAL_AWS_VARS) delete env[k];
  return { ...env, ...flociEnv() };
}

/** Points this process (SDK clients created afterwards) at Floci only. */
export function useLocalEnv(): void {
  for (const k of REAL_AWS_VARS) delete process.env[k];
  Object.assign(process.env, flociEnv());
}

/** Fails fast with a clear message instead of a hung CDK/SDK call. */
export async function assertFlociUp(fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    await fetchFn(`${FLOCI_ENDPOINT}/_floci/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(`Floci not reachable at ${FLOCI_ENDPOINT} — run \`npm run floci:up\``);
  }
}

/**
 * Floci answers AWS hostnames under *.localhost.floci.io:4566 (public DNS → 127.0.0.1), over plain http/ws.
 * Parsed by regex, not `new URL()`: Floci's own Function URL form `<id>.lambda-url.us-east-1.127.0.0.1:4566`
 * is not a valid URL host.
 */
export function flociHost(awsUrl: string): string {
  const m = /^[a-z]+:\/\/([a-z0-9]+)\.(execute-api|lambda-url)\./.exec(awsUrl);
  if (!m) throw new Error(`unknown AWS URL: ${awsUrl}`);
  return `${m[1]}.${m[2] === "lambda-url" ? "lambda-url.us-east-1" : "execute-api"}.localhost.floci.io:4566`;
}

export const AWS_STAGE_REGION = "ap-southeast-2";

/**
 * Env for real AWS (stage aws): never an emulator endpoint or Floci's fake keys, a named profile
 * (default `ig`, from `aws login --profile ig`) and the project's fixed region, Sydney.
 */
export function awsEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (base.AWS_ENDPOINT_URL) {
    throw new Error("stage aws: unset AWS_ENDPOINT_URL first (it points at an emulator). Refusing.");
  }
  if (base.AWS_ACCESS_KEY_ID === "test") {
    throw new Error("stage aws: AWS_ACCESS_KEY_ID=test is Floci's fake key. Unset it so your AWS profile is used.");
  }
  return { ...base, AWS_PROFILE: base.AWS_PROFILE || "ig", AWS_REGION: AWS_STAGE_REGION, AWS_DEFAULT_REGION: AWS_STAGE_REGION };
}

/** Points this process (SDK clients created afterwards) at real AWS via the profile. */
export function useAwsEnv(): void {
  Object.assign(process.env, awsEnv(process.env));
}
