import { Aspects, type Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { AwsSolutionsChecks, NagSuppressions, type NagPackSuppression } from "cdk-nag";

const rule = (id: string, reason: string, appliesTo?: RegExp[]): NagPackSuppression => ({
  id: `AwsSolutions-${id}`, reason, ...(appliesTo && { appliesTo: appliesTo.map((r) => ({ regex: String(r) })) }),
});

/**
 * An ARN in this stack's region and account. A synth without credentials leaves the account to CloudFormation, and
 * cdk-nag then shows it as <AWS::AccountId>.
 */
const ownArn = (service: string, resource: string) =>
  new RegExp(`^Resource::arn:<AWS::Partition>:${service}:[a-z0-9-]+:(\\d{12}|<AWS::AccountId>):${resource}$`);

/** Wildcards that CDK grants or run-time names force into our own policies, each matched exactly. */
const RUNTIME_WILDCARDS = [
  rule("IAM5", "CDK's table grants also cover the table's indexes (only gsi1), which it writes as index/*.",
    [/^Resource::<Main[0-9A-F]{8}\.Arn>\/index\/\*$/]),
  rule("IAM5", "Each function reaches only its own key prefix of the files bucket; the object names are made at run time.",
    [/^Resource::<Files[0-9A-F]{8}\.Arn>\/(rooms|workspaces|staging|generated|speech)\/\*$/]),
  rule("IAM5", "Socket connection ids exist only at run time, so the grant is POST on the one stage's @connections path.",
    [ownArn("execute-api", "<Ws[0-9A-F]{8}>/live/POST/@connections/\\*")]),
  rule("IAM5", "A durable execution's ARN is the run function's qualified ARN plus an id made at run time.",
    [ownArn("lambda", "function:cl-aws-run:\\*")]),
  rule("IAM5", "Room schedules are named at run time, so the grant covers the schedules in the stack's own schedule group.",
    [ownArn("scheduler", "schedule/cl-aws-agent-schedules/\\*")]),
];

/** HTTP API routes without the JWT authorizer, and why each is safe without it. */
const PUBLIC_ROUTES: [string[], string][] = [
  [["GET /health"], "A liveness check that returns nothing private."],
  [["GET /invites/{code}"], "The invite page shows the room before sign-in; the unguessable code is the credential."],
  [["GET /mcp", "POST /mcp", "DELETE /mcp"],
    "MCP clients send chat-lite's own OAuth access tokens, which the MCP function checks itself with one consistent read."],
  [[
    "GET /.well-known/oauth-authorization-server", "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/oauth-protected-resource/mcp", "POST /oauth/register", "GET /oauth/authorize", "POST /oauth/token",
    "POST /oauth/revoke",
  ], "OAuth discovery, registration, authorize, token and revoke are how an MCP client gets a token, so they can't need one."],
];

/** Findings on one resource each, by construct path under the stack. */
const BY_PATH: [string[], NagPackSuppression[]][] = [
  [["Users"], [
    rule("COG1", "The password policy is at least 8 characters with no composition rules, as NIST SP 800-63B advises."),
    rule("COG2", "MFA would add a TOTP setup for a few invited friends; every account has a verified email instead."),
    rule("COG8", "Cognito threat protection needs the Plus tier, billed per monthly active user."),
  ]],
  [["ModelKeys", "ToolKeys"], [
    rule("SMG4", "Third-party API keys are issued by their providers, so they are rotated by hand there, not by a Lambda."),
  ]],
  [["PushKeys", "PushPublicKey"], [
    rule("SMG4", "A new VAPID key pair would orphan every browser's push subscription, so the keys are changed by hand, with a resubscribe."),
  ]],
  [["TokenKey"], [
    rule("SMG4", "Rotating the sealing key would leave every sealed MCP token unreadable until each one is sealed again."),
  ]],
  [["Files"], [
    rule("S1", "Every upload and download goes through a URL a logged function signs; server access logs would need a second bucket."),
  ]],
  [["Web"], [rule("S1", "Only CloudFront reads the site's build output, through OAC, and CloudFront's metrics count those reads.")]],
  [["Site"], [
    rule("CFR1", "The site is for invited friends wherever they live, so there is no country to block."),
    rule("CFR2", "AWS WAF costs at least $5 a month; the API throttles and Cognito's own limits cover a friends-only site."),
    rule("CFR3", "Access logs would need a log bucket; CloudFront's metrics and the web Lambda's logs cover a friends-only site."),
  ]],
  [["WsStage"], [
    rule("APIG1", "A WebSocket stage logs access only through the account-wide API Gateway role every stack would share; the live Lambda logs instead."),
  ]],
  [["Fn-voice/ServiceRole/DefaultPolicy"], [
    rule("IAM5", "Transcribe streaming has no resource to scope to, and Polly's only one is lexicons, which chat-lite doesn't use.",
      [/^Resource::\*$/]),
  ]],
  [["Fn-run/ServiceRole"], [
    rule("IAM4", "AWS's durable execution policy is the documented minimum for a function to checkpoint and resume.",
      [/^Policy::arn:<AWS::Partition>:iam::aws:policy\/service-role\/AWSLambdaBasicDurableExecutionRolePolicy$/]),
  ]],
];

const SOCKET_ROUTES = rule("APIG4",
  "$connect checks the one-time ticket from the JWT-protected POST /live/ticket itself; every other route runs only on a connection it accepted.");

/** CDK's own asset-copy handler, whose grants and runtime come with aws-cdk-lib. */
const ASSET_COPY = [
  rule("IAM5", "CDK's asset-copy handler copies the whole build from CDK's staging bucket into the web bucket, so it needs every object in both."),
  rule("L1", "CDK picks its asset-copy handler's runtime and moves it with aws-cdk-lib releases."),
];

const BASIC_EXECUTION = rule("IAM4", "AWS's basic execution policy only lets a function write CloudWatch Logs.",
  [/^Policy::arn:<AWS::Partition>:iam::aws:policy\/service-role\/AWSLambdaBasicExecutionRole$/]);
const NODE_22 = rule("L1", "Node 22 is the runtime every function is proven on, in Floci and on AWS; they move to a newer one together.");

/**
 * Runs the AwsSolutions rules on every synth, so a new finding fails `cdk synth`. Each exception names its resource
 * (a path that no longer exists throws) and says why it is accepted.
 */
export function addComplianceChecks(stack: Stack): void {
  Aspects.of(stack).add(new AwsSolutionsChecks());
  const path = (id: string) => `${stack.node.path}/${id}`;
  NagSuppressions.addStackSuppressions(stack, RUNTIME_WILDCARDS);
  for (const [routes, reason] of PUBLIC_ROUTES) {
    const ids = routes.map((route) => `Api/${route.replace(" ", "").replaceAll("/", "--")}`);
    NagSuppressions.addResourceSuppressionsByPath(stack, ids.map(path), [rule("APIG4", reason)]);
  }
  for (const [ids, rules] of BY_PATH) NagSuppressions.addResourceSuppressionsByPath(stack, ids.map(path), rules);
  // A WebSocket API takes an authorizer only on $connect, so this one exception covers every route of the socket.
  NagSuppressions.addResourceSuppressionsByPath(stack, path("Ws"), [SOCKET_ROUTES], true);
  const assetCopy = stack.node.children.filter((c) => c.node.id.startsWith("Custom::CDKBucketDeployment"));
  NagSuppressions.addResourceSuppressions(assetCopy, ASSET_COPY, true);
  for (const fn of stack.node.findAll().filter((c) => c instanceof lambda.Function)) {
    NagSuppressions.addResourceSuppressions(fn.role!, [BASIC_EXECUTION], true);
    if (fn.runtime.name === lambda.Runtime.NODEJS_22_X.name) NagSuppressions.addResourceSuppressions(fn, [NODE_22]);
  }
}
