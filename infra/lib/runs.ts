import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { CoreStack } from "./core-stack.js";

/**
 * The agent's run loop: a Lambda durable function. One execution is one run, checkpointed step by step, so a run can
 * last longer than a single 15-minute invocation. It is started by alias, because a durable function must be
 * invoked through a version or alias, never $LATEST.
 */
export function addRuns(stack: CoreStack) {
  const { prefix, isLocal, modelGateway, toolMode } = stack.stageConfig;
  // The keys are set by hand, so AWS keeps them past a stack delete. Leave the generated value as is: changing the
  // generator makes CloudFormation write a new value over the hand-set keys.
  const removalPolicy = isLocal ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
  // The provider keys live only in this secret, as JSON {ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL}. Its
  // value is set outside CloudFormation, so no key ever appears in a template or a Lambda environment variable.
  const keysName = `${prefix}-model-keys`;
  const modelKeys = new secretsmanager.Secret(stack, "ModelKeys", {
    secretName: keysName,
    description: "Model provider API keys for the run loop",
    removalPolicy,
  });
  // JSON {TAVILY_API_KEY, GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY}, kept apart from the model keys so
  // the connections function can read these without being able to read those.
  const toolKeysName = `${prefix}-tool-keys`;
  const toolKeys = new secretsmanager.Secret(stack, "ToolKeys", {
    secretName: toolKeysName,
    description: "GitHub App and web search keys for the agent's tools",
    removalPolicy,
  });
  const toolEnvironment = { TOOL_MODE: toolMode, TOOL_KEYS_SECRET: toolKeysName };
  const runFn = stack.addFunction("run", "runs/loop.ts", { tableAccess: true }, {
    timeout: Duration.minutes(15),
    // A run's own time is capped at two hours, but a write may wait on a member's approval for up to a day, and paused
    // time costs nothing, so the execution itself may last a week.
    durableConfig: { executionTimeout: Duration.days(7), retentionPeriod: Duration.days(7) },
    environment: { MODEL_GATEWAY: modelGateway, MODEL_KEYS_SECRET: keysName, ...toolEnvironment },
  });
  modelKeys.grantRead(runFn);
  toolKeys.grantRead(runFn);
  stack.allowBroadcast(runFn);
  const alias = new lambda.Alias(stack, "RunLive", { aliasName: "live", version: runFn.currentVersion });
  return { runFn, alias, toolKeys, toolEnvironment };
}
