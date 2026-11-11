import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { CoreStack } from "./core-stack.js";

/**
 * The agent's run loop: a Lambda durable function. One execution is one run, checkpointed step by step, so a run can
 * last longer than a single 15-minute invocation. It is started by alias, because a durable function must be
 * invoked through a version or alias, never $LATEST.
 */
export function addRuns(stack: CoreStack) {
  const runFn = stack.addFunction("run", "runs/loop.ts", { tableAccess: true }, {
    timeout: Duration.minutes(15),
    durableConfig: { executionTimeout: Duration.minutes(130), retentionPeriod: Duration.days(7) },
    environment: { MODEL_GATEWAY: "fake" },
  });
  stack.allowBroadcast(runFn);
  const alias = new lambda.Alias(stack, "RunLive", { aliasName: "live", version: runFn.currentVersion });
  return { runFn, alias };
}
