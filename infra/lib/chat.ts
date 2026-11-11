import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { CoreStack } from "./core-stack.js";

/**
 * Socket tickets, message history, search and file uploads: one Lambda behind the HTTP API's JWT authorizer. Files go
 * straight between the browser and a private bucket on presigned URLs: the chat Lambda signs uploads and downloads,
 * and the live Lambda signs downloads for the messages it sends out. The same bucket holds the room's files.
 */
export function addChat(stack: CoreStack) {
  const { prefix, isLocal, siteOrigins, s3PublicEndpoint } = stack.stageConfig;
  const files = new s3.Bucket(stack, "Files", {
    // Bucket names are global across every AWS account, so the real one carries ours. Floci's is local to it.
    bucketName: isLocal ? `${prefix}-files` : `${prefix}-files-${stack.account}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: !isLocal, // Floci serves plain http.
    // A room file is uploaded to staging and copied into the room when its commit is accepted, so anything left in
    // staging was abandoned or refused.
    lifecycleRules: [{ prefix: "staging/", expiration: Duration.days(1) }],
    cors: [{ allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.GET], allowedOrigins: siteOrigins, allowedHeaders: ["*"] }],
    // Uploads are user data, so on AWS the bucket outlives a `cdk destroy`; locally Floci's data is disposable. CDK's
    // autoDeleteObjects can't empty it first on Floci: its custom-resource Lambda calls S3 on port 443, which Floci
    // doesn't serve.
    ...(isLocal && { removalPolicy: RemovalPolicy.DESTROY }),
  });

  const fn = stack.addFunction("chat", "chat/handler.ts");
  // Its routes only read, apart from issuing a socket ticket.
  stack.table.grantReadData(fn);
  stack.table.grant(fn, "dynamodb:PutItem");
  fn.addEnvironment("WS_URL", stack.wsUrl);
  files.grantPut(fn, "rooms/*");
  // Signing a download needs only GetObject on the uploads; the live Lambda's HeadObject of a new attachment does too.
  const readUploads = new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [files.arnForObjects("rooms/*")] });
  for (const signer of [fn, stack.live.liveFn]) {
    signer.addToRolePolicy(readUploads);
    signer.addEnvironment("FILES_BUCKET", files.bucketName);
    if (s3PublicEndpoint) signer.addEnvironment("S3_PUBLIC_ENDPOINT", s3PublicEndpoint);
  }

  // Not under /ws: Floci answers every /ws/* path on the HTTP API host itself, before any route is matched.
  stack.route("POST", "/live/ticket", fn);
  stack.route("GET", "/rooms/{roomId}/chats/{chatId}/messages", fn);
  stack.route("GET", "/rooms/{roomId}/search", fn);
  stack.route("POST", "/rooms/{roomId}/attachments", fn);
  return files;
}
