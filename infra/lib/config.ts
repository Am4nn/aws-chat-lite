export type Stage = "local" | "aws";

export interface StageConfig {
  stage: Stage;
  /** Prefix for every stack and resource name: cl-<stage> */
  prefix: "cl-local" | "cl-aws";
  isLocal: boolean;
  /** Floci's us-east-1 locally, Sydney (ap-southeast-2) on real AWS. */
  region: "us-east-1" | "ap-southeast-2";
  /** Where the web app is served from: the browser origins allowed to upload to and download from the files bucket. */
  siteOrigins: string[];
  /**
   * S3 as the browser reaches it, when that differs from what the Lambdas use: locally Floci's port on the host,
   * because a Lambda's own S3 endpoint is an address inside Docker.
   */
  s3PublicEndpoint?: string;
  /** Which models answer: the fake, or the real providers. Real models cost money, so local opts in. */
  modelGateway: "fake" | "live";
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
    return {
      stage, prefix: "cl-local", isLocal: true, region: "us-east-1",
      siteOrigins: ["http://localhost:3000", "http://localhost:3100"], s3PublicEndpoint: "http://localhost:4566",
      modelGateway: env.MODEL_GATEWAY === "live" ? "live" : "fake",
    };
  }
  if (stage === "aws") {
    if (env.AWS_ENDPOINT_URL) throw new Error("stage=aws: unset AWS_ENDPOINT_URL first (it is pointing at an emulator).");
    return {
      stage, prefix: "cl-aws", isLocal: false, region: "ap-southeast-2", siteOrigins: ["https://chat.amanarya.com"],
      modelGateway: "live",
    };
  }
  throw new Error(`stage must be local or aws (got "${stage}"). Pass -c stage=local`);
}
