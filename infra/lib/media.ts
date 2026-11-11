import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { CoreStack } from "./core-stack.js";

/**
 * Web push, voice, and what the run function needs for images. Push is a worker that other Lambdas invoke
 * asynchronously, plus the routes a browser subscribes through; voice is one Lambda that mints dictation sessions
 * and reads answers aloud.
 */
export function addMedia(stack: CoreStack, files: s3.Bucket) {
  const { prefix, isLocal, pushMode, voiceMode, transcribeLocalUrl, s3PublicEndpoint } = stack.stageConfig;
  const filesEnvironment = { FILES_BUCKET: files.bucketName, ...(s3PublicEndpoint && { S3_PUBLIC_ENDPOINT: s3PublicEndpoint }) };

  // JSON {VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT}, set outside CloudFormation like the model keys. The
  // routes a browser calls need only the public key, and a secret is read whole, so they get a copy of it in a secret
  // of its own and never see the private key. Push services tie each browser subscription to the public key, so on AWS
  // both outlive a stack delete: new keys would silently orphan every subscribed device. Until the keys are set each
  // holds JSON without them, which reads as push being off; CloudFormation's default would be a random password, which
  // isn't JSON.
  const pushSecret = (id: string, secretName: string, description: string) => new secretsmanager.Secret(stack, id, {
    secretName,
    description,
    generateSecretString: { secretStringTemplate: "{}", generateStringKey: "unset" },
    removalPolicy: isLocal ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
  });
  const keysName = `${prefix}-push-keys`;
  const publicKeyName = `${prefix}-push-public-key`;
  const pushKeys = pushSecret("PushKeys", keysName, "VAPID keys that sign web push notifications");
  const publicKey = pushSecret("PushPublicKey", publicKeyName, "The VAPID public key browsers subscribe to web push with");
  const pushFn = stack.addFunction("push", "push/delivery/handler.ts", {}, {
    timeout: Duration.seconds(30),
    environment: { PUSH_MODE: pushMode, PUSH_KEYS_SECRET: keysName },
  });
  // Lambda retries a failed async event twice by default; a late duplicate notification is worse than a missed one.
  pushFn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(5) });
  const routesFn = stack.addFunction("push-routes", "push/handler.ts", {}, { environment: { PUSH_PUBLIC_KEY_SECRET: publicKeyName } });
  pushKeys.grantRead(pushFn);
  publicKey.grantRead(routesFn);
  for (const fn of [pushFn, routesFn]) {
    // Subscriptions are only ever put or deleted whole, never updated.
    stack.table.grantReadData(fn);
    stack.table.grant(fn, "dynamodb:PutItem", "dynamodb:DeleteItem");
  }
  stack.route("GET", "/push/key", routesFn);
  stack.route("PUT", "/me/push", routesFn);
  stack.route("DELETE", "/me/push/{id}", routesFn);

  // A long answer is synthesized in several Polly calls, and API Gateway gives up on an integration after 30 s.
  const voiceFn = stack.addFunction("voice", "voice/handler.ts", { tableAccess: true }, {
    timeout: Duration.seconds(25),
    memorySize: 512,
    environment: { VOICE_MODE: voiceMode, ...filesEnvironment, ...(transcribeLocalUrl && { TRANSCRIBE_LOCAL_URL: transcribeLocalUrl }) },
  });
  // Neither action supports resource-level permissions. The browser streams on a URL signed with this role's
  // credentials, so the role itself must be allowed to start the stream.
  voiceFn.addToRolePolicy(new iam.PolicyStatement({
    actions: ["polly:SynthesizeSpeech", "transcribe:StartStreamTranscriptionWebSocket"], resources: ["*"],
  }));
  voiceFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [files.arnForObjects("speech/*")] }));
  stack.route("POST", "/rooms/{roomId}/voice/sessions", voiceFn);
  stack.route("POST", "/rooms/{roomId}/voice/sessions/{sessionId}/done", voiceFn);
  stack.route("POST", "/rooms/{roomId}/speech", voiceFn);

  // The run function shows the model the images members attached, and stages each generated image before committing
  // it as a room file (its room-files rights cover the copy into workspaces/).
  const { runFn } = stack.runs;
  runFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [files.arnForObjects("rooms/*")] }));
  runFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [files.arnForObjects("generated/*")] }));
  return pushFn;
}
