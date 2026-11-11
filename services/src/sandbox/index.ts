import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { agentCoreSandbox } from "./agentcore.js";
import { remoteSandbox } from "./remote.js";
import type { Sandbox } from "./sandbox.js";

let cached: Sandbox | undefined;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} not set`);
  return value;
}

/** Where the run function executes code: Docker behind the local sandbox server, or AgentCore's Code Interpreter on AWS. */
export function sandbox(env: NodeJS.ProcessEnv = process.env): Sandbox {
  if (cached) return cached;
  if (env.SANDBOX_KIND === "docker") {
    cached = remoteSandbox(required(env, "SANDBOX_URL"), required(env, "SANDBOX_TOKEN"));
  } else if (env.SANDBOX_KIND === "agentcore") {
    cached = agentCoreSandbox({
      client: new BedrockAgentCoreClient({}), offlineId: required(env, "SANDBOX_OFFLINE_ID"), onlineId: required(env, "SANDBOX_ONLINE_ID"),
    });
  } else {
    throw new Error(`Unknown sandbox: ${env.SANDBOX_KIND}`);
  }
  return cached;
}
