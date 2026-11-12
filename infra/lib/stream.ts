import { Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { CoreStack } from "./core-stack.js";

/**
 * A run's resumable event stream: server-sent events from a Lambda with response streaming, behind a Function URL
 * (API Gateway buffers responses, so it can't stream). The URL needs no IAM auth because the one-time ticket in it is
 * the auth, and since no cookies travel, CORS can allow any origin. On AWS browsers reach it through the site, whose
 * CloudFront routes each run's stream path to the Function URL.
 */
export function addStream(stack: CoreStack) {
  const fn = stack.addFunction("stream", "runs/stream-handler.ts", { timeout: Duration.minutes(15) });
  stack.table.grantReadData(fn);
  // Using a ticket deletes it; the condition keeps that delete to ticket items.
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ["dynamodb:DeleteItem"],
    resources: [stack.table.tableArn],
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["STREAMTICKET#*"] } },
  }));
  const url = fn.addFunctionUrl({
    authType: lambda.FunctionUrlAuthType.NONE,
    invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    cors: { allowedOrigins: ["*"], allowedHeaders: ["last-event-id"], allowedMethods: [lambda.HttpMethod.GET] },
  });
  const { streamLocalUrl, siteOrigins } = stack.stageConfig;
  return { streamUrl: streamLocalUrl ?? siteOrigins[0]!, functionUrl: url };
}
