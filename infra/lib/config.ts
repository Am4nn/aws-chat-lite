export type Stage = "local" | "aws";

export interface StageConfig {
  stage: Stage;
  /** Prefix for every stack and resource name: cl-<stage> */
  prefix: "cl-local" | "cl-aws";
  isLocal: boolean;
  /** Floci's us-east-1 locally, Sydney (ap-southeast-2) on real AWS. */
  region: "us-east-1" | "ap-southeast-2";
}

function isFlociEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host.endsWith(".floci.io");
  } catch {
    return false;
  }
}

/** Safety guard: local must hit Floci, aws must not have an endpoint override. */
export function loadConfig(stage: string | undefined, env: NodeJS.ProcessEnv): StageConfig {
  if (stage === "local") {
    if (!isFlociEndpoint(env.AWS_ENDPOINT_URL)) {
      throw new Error(
        "stage=local but AWS_ENDPOINT_URL must point at Floci (e.g. http://localhost:4566). Refusing to touch real AWS.",
      );
    }
    return { stage, prefix: "cl-local", isLocal: true, region: "us-east-1" };
  }
  if (stage === "aws") {
    if (env.AWS_ENDPOINT_URL) throw new Error("stage=aws: unset AWS_ENDPOINT_URL first (it is pointing at an emulator).");
    return { stage, prefix: "cl-aws", isLocal: false, region: "ap-southeast-2" };
  }
  throw new Error(`stage must be local or aws (got "${stage}"). Pass -c stage=local`);
}
