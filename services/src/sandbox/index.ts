import type { Sandbox } from "./sandbox.js";

let cached: Promise<Sandbox> | undefined;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} not set`);
  return value;
}

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
    return remoteSandbox(required(env, "SANDBOX_URL"), required(env, "SANDBOX_TOKEN"));
  }
  if (env.SANDBOX_KIND === "agentcore") {
    const [{ BedrockAgentCoreClient }, { agentCoreSandbox }] = await Promise.all([
      import("@aws-sdk/client-bedrock-agentcore"), import("./agentcore.js"),
    ]);
    return agentCoreSandbox({
      client: new BedrockAgentCoreClient({}), offlineId: required(env, "SANDBOX_OFFLINE_ID"), onlineId: required(env, "SANDBOX_ONLINE_ID"),
    });
  }
  throw new Error(`Unknown sandbox: ${env.SANDBOX_KIND}`);
}
