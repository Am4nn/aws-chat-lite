import { RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { CoreStack } from "./core-stack.js";

/**
 * Socket tickets, message history, search and file uploads: one Lambda behind the HTTP API's JWT authorizer. Files go
 * straight between the browser and a private bucket on presigned URLs: the chat Lambda signs uploads and downloads,
 * and the live Lambda signs downloads for the messages it sends out.
 */
export function addChat(stack: CoreStack) {
  const { prefix, isLocal, siteOrigins, s3PublicEndpoint } = stack.stageConfig;
  const files = new s3.Bucket(stack, "Files", {
    bucketName: `${prefix}-files`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: !isLocal, // Floci serves plain http.
    cors: [{ allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.GET], allowedOrigins: siteOrigins, allowedHeaders: ["*"] }],
    // Uploads are user data, so on AWS the bucket outlives a `cdk destroy`; locally Floci's data is disposable. CDK's
    // autoDeleteObjects can't empty it first on Floci: its custom-resource Lambda calls S3 on port 443, which Floci
    // doesn't serve.
    ...(isLocal && { removalPolicy: RemovalPolicy.DESTROY }),
  });

  const fn = stack.addFunction("chat", "chat/handler.ts", { tableAccess: true });
  fn.addEnvironment("WS_URL", stack.wsUrl);
  files.grantPut(fn);
  for (const signer of [fn, stack.live.liveFn]) {
    files.grantRead(signer);
    signer.addEnvironment("FILES_BUCKET", files.bucketName);
    if (s3PublicEndpoint) signer.addEnvironment("S3_PUBLIC_ENDPOINT", s3PublicEndpoint);
  }

  // Not under /ws: Floci answers every /ws/* path on the HTTP API host itself, before any route is matched.
  stack.route("POST", "/live/ticket", fn);
  stack.route("GET", "/rooms/{roomId}/chats/{chatId}/messages", fn);
  stack.route("GET", "/rooms/{roomId}/search", fn);
  stack.route("POST", "/rooms/{roomId}/attachments", fn);
}
