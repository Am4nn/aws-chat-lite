import { requiredEnv } from "../lib/env.js";
import type { Sandbox } from "./sandbox.js";

let cached: Promise<Sandbox> | undefined;

/**
 * Where the run function executes code: Docker behind the local sandbox server, or AgentCore's Code Interpreter on
 * AWS. The adapter is imported on first use, so the Lambdas that only close runs never load its SDK.
 */
export function sandbox(env: NodeJS.ProcessEnv = process.env): Promise<Sandbox> {
  return (cached ??= load(env));
}

async function load(env: NodeJS.ProcessEnv): Promise<Sandbox> {
  if (env.SANDBOX_KIND === "docker") {
    const { remoteSandbox } = await import("./remote.js");
    return remoteSandbox(requiredEnv("SANDBOX_URL", env), requiredEnv("SANDBOX_TOKEN", env));
  }
  if (env.SANDBOX_KIND === "agentcore") {
    const [{ BedrockAgentCoreClient }, { agentCoreSandbox }] = await Promise.all([
      import("@aws-sdk/client-bedrock-agentcore"), import("./agentcore.js"),
    ]);
    return agentCoreSandbox({
      client: new BedrockAgentCoreClient({}), offlineId: requiredEnv("SANDBOX_OFFLINE_ID", env), onlineId: requiredEnv("SANDBOX_ONLINE_ID", env),
    });
  }
  throw new Error(`Unknown sandbox: ${env.SANDBOX_KIND}`);
}
