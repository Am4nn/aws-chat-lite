import { Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { CoreStack } from "./core-stack.js";
import { issuerEnvironment } from "./oauth.js";

/**
 * chat-lite as an MCP server: one Lambda on `/mcp`, with no authorizer because it checks its own opaque bearer tokens
 * (one consistent read each, so a revoked app is out at once). Its tools do what the web app does: post and tell the
 * room, start agent runs, and read history, which signs download links for attachments. Posting can hand a message
 * to the agent and wait for the run to start, so it gets longer than the default timeout.
 */
export function addMcpServer(stack: CoreStack, files: s3.Bucket) {
  const { s3PublicEndpoint } = stack.stageConfig;
  const fn = stack.addFunction("mcp", "mcp/server/handler.ts", { tableAccess: true }, {
    timeout: Duration.seconds(30),
    environment: {
      ...issuerEnvironment(stack), FILES_BUCKET: files.bucketName, ...(s3PublicEndpoint && { S3_PUBLIC_ENDPOINT: s3PublicEndpoint }),
    },
  });
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [files.arnForObjects("rooms/*")] }));
  stack.allowBroadcast(fn);
  stack.allowRunStart(fn);
  for (const method of ["POST", "GET", "DELETE"]) stack.route(method, "/mcp", fn, { public: true });
}
