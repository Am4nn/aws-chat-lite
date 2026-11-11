export type Stage = "local" | "aws";

const DOMAIN_NAME = "chat.amanarya.com";

/**
 * Requests per second for every route of the AWS API and socket stages. On the socket stage it also limits `$connect`,
 * the connection-rate protection: a flood of new sockets is refused at the edge before any Lambda runs.
 */
export const EDGE_THROTTLE = { rateLimit: 50, burstLimit: 100 };

/** What only a real deploy needs: the public domain, its certificate and who the alarms mail. */
export interface ProdSettings {
  domainName: typeof DOMAIN_NAME;
  alertEmail: string;
  /** CloudFront only reads certificates from ACM in us-east-1, whatever region the stack is in. */
  certificateArn: string;
}

/** Account-specific values, read from the gitignored infra/cdk.context.json so they never enter git. */
type DeployContext = { alertEmail?: string; certificateArn?: string };

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
  /**
   * AWS only: the public base of the OAuth and MCP endpoints, the issuer MCP clients see. Locally it is the API's own
   * Floci host, which only exists once the API does.
   */
  mcpBaseUrl?: string;
  /** Which models answer: the fake, or the real providers. Real models cost money, so local opts in. */
  modelGateway: "fake" | "live";
  /** Which GitHub App and web search the tools reach: a canned fake, or the real ones. Locally that is opt-in too. */
  toolMode: "fake" | "live";
  /** Local only: the secret the run function sends to the Docker sandbox server on the developer's machine. */
  sandboxToken?: string;
  /** Set on AWS only. */
  prod?: ProdSettings;
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
export function loadConfig(stage: string | undefined, env: NodeJS.ProcessEnv, context: DeployContext = {}): StageConfig {
  if (stage === "local") {
    if (!isFlociEndpoint(env.AWS_ENDPOINT_URL)) {
      throw new Error(
        "stage=local but AWS_ENDPOINT_URL must point at Floci (e.g. http://localhost:4566). Refusing to touch real AWS.",
      );
    }
    return {
      stage, prefix: "cl-local", isLocal: true, region: "us-east-1",
      siteOrigins: ["http://localhost:3000", "http://localhost:3100"], s3PublicEndpoint: "http://localhost:4566",
      modelGateway: env.MODEL_GATEWAY === "live" ? "live" : "fake", toolMode: env.TOOL_MODE === "live" ? "live" : "fake",
      ...(env.SANDBOX_TOKEN && { sandboxToken: env.SANDBOX_TOKEN }),
    };
  }
  if (stage === "aws") {
    if (env.AWS_ENDPOINT_URL) throw new Error("stage=aws: unset AWS_ENDPOINT_URL first (it is pointing at an emulator).");
    return {
      stage, prefix: "cl-aws", isLocal: false, region: "ap-southeast-2", siteOrigins: [`https://${DOMAIN_NAME}`],
      mcpBaseUrl: `https://${DOMAIN_NAME}`, modelGateway: "live", toolMode: "live", prod: prodSettings(context),
    };
  }
  throw new Error(`stage must be local or aws (got "${stage}"). Pass -c stage=local`);
}

function prodSettings({ alertEmail, certificateArn }: DeployContext): ProdSettings {
  if (!alertEmail || !certificateArn) {
    const missing = [!alertEmail && "alertEmail", !certificateArn && "certificateArn"].filter(Boolean).join(", ");
    throw new Error(`stage=aws is missing ${missing} in infra/cdk.context.json (copy infra/cdk.context.example.json).`);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alertEmail)) throw new Error(`alertEmail "${alertEmail}" is not an email address.`);
  if (!certificateArn.startsWith("arn:aws:acm:us-east-1:")) {
    throw new Error("certificateArn must be an ACM certificate in us-east-1 (CloudFront only reads certificates there).");
  }
  return { domainName: DOMAIN_NAME, alertEmail, certificateArn };
}
