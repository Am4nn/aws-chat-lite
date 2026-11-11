import * as iam from "aws-cdk-lib/aws-iam";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { CoreStack } from "./core-stack.js";

/**
 * Where the run function executes code. Floci has no AgentCore, so locally the run function talks to a Docker host helper.
 * On AWS there are two interpreters, one without network and one with it, so the room's internet switch picks a whole interpreter.
 * Neither has an execution role: code inside must never hold AWS credentials.
 */
export function addSandbox(stack: CoreStack, runFn: NodejsFunction) {
  const { prefix, isLocal } = stack.stageConfig;
  if (isLocal) {
    runFn.addEnvironment("SANDBOX_KIND", "docker");
    runFn.addEnvironment("SANDBOX_URL", "http://host.docker.internal:4700");
    return;
  }

  const interpreter = (id: string, suffix: string, networkMode: "SANDBOX" | "PUBLIC") =>
    new agentcore.CfnCodeInterpreterCustom(stack, id, {
      // Interpreter names allow letters, digits and underscores only.
      name: `${prefix.replaceAll("-", "_")}_sandbox_${suffix}`,
      networkConfiguration: { networkMode },
    });
  const offline = interpreter("SandboxOffline", "offline", "SANDBOX");
  const online = interpreter("SandboxOnline", "online", "PUBLIC");

  runFn.addEnvironment("SANDBOX_KIND", "agentcore");
  runFn.addEnvironment("SANDBOX_OFFLINE_ID", offline.attrCodeInterpreterId);
  runFn.addEnvironment("SANDBOX_ONLINE_ID", online.attrCodeInterpreterId);
  runFn.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      "bedrock-agentcore:StartCodeInterpreterSession",
      "bedrock-agentcore:InvokeCodeInterpreter",
      "bedrock-agentcore:StopCodeInterpreterSession",
    ],
    resources: [offline.attrCodeInterpreterArn, online.attrCodeInterpreterArn],
  }));
}
