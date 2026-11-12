import { Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { CoreStack } from "./core-stack.js";

/**
 * Socket tickets, message history, search and file uploads: one Lambda behind the HTTP API's JWT authorizer. Files go
 * straight between the browser and a private bucket on presigned URLs: the chat Lambda signs uploads and downloads,
 * and the live Lambda signs downloads for the messages it sends out. The same bucket holds the room's files.
 */
export function addChat(stack: CoreStack) {
  const { prefix, isLocal, siteOrigins } = stack.stageConfig;
  const files = new s3.Bucket(stack, "Files", {
    // Bucket names are global across every AWS account, so the real one carries ours. Floci's is local to it.
    bucketName: isLocal ? `${prefix}-files` : `${prefix}-files-${stack.account}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: !isLocal, // Floci serves plain http.
    // A room file is uploaded to staging and copied into the room when its commit is accepted, so anything left in
    // staging was abandoned or refused; a generated image is staged the same way. Read-aloud audio is a cache: an
    // answer played again after 30 days is synthesized (and paid for) again.
    lifecycleRules: [
      { prefix: "staging/", expiration: Duration.days(1) },
      { prefix: "generated/", expiration: Duration.days(1) },
      { prefix: "speech/", expiration: Duration.days(30) },
    ],
    cors: [{ allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.GET], allowedOrigins: siteOrigins, allowedHeaders: ["*"] }],
    // No autoDeleteObjects, even locally: its custom-resource Lambda calls S3 on port 443, which Floci doesn't serve.
    removalPolicy: stack.userDataRemoval,
  });

  const fn = stack.addFunction("chat", "chat/handler.ts");
  // Its routes only read, apart from issuing a socket ticket.
  stack.table.grantReadData(fn);
  stack.table.grant(fn, "dynamodb:PutItem");
  fn.addEnvironment("WS_URL", stack.wsUrl);
  // A presigned POST upload needs only PutObject. CDK's grantPut adds tagging, retention and multipart aborts.
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [files.arnForObjects("rooms/*")] }));
  // Signing a download needs only GetObject on the uploads; the live Lambda's HeadObject of a new attachment does too.
  const readUploads = new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [files.arnForObjects("rooms/*")] });
  for (const signer of [fn, stack.live.liveFn]) {
    signer.addToRolePolicy(readUploads);
    for (const [name, value] of Object.entries(stack.filesEnvironment(files))) signer.addEnvironment(name, value);
  }

  // Not under /ws: Floci answers every /ws/* path on the HTTP API host itself, before any route is matched.
  stack.route("POST", "/live/ticket", fn);
  stack.route("GET", "/rooms/{roomId}/chats/{chatId}/messages", fn);
  stack.route("GET", "/rooms/{roomId}/search", fn);
  stack.route("POST", "/rooms/{roomId}/attachments", fn);
  return files;
}
