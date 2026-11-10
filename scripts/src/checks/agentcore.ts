import {
  BedrockAgentCoreClient, StartCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand, StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { check, withTimeout, assert } from "./util.js";

/** AWS's built-in sandbox (no resource to create): a fresh microVM session per call. */
const BUILT_IN = "aws.codeinterpreter.v1";

export async function run() {
  const client = new BedrockAgentCoreClient({});
  return [
    await check("AgentCore Code Interpreter", "start a session, run Python print(6*7) → 42, stop it", async () => {
      const t0 = Date.now();
      const { sessionId } = await withTimeout(client.send(new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: BUILT_IN, name: `cl-spike-${Date.now()}`, sessionTimeoutSeconds: 300,
      })), 60_000, "start session");
      const startedMs = Date.now() - t0;
      try {
        const res = await withTimeout(client.send(new InvokeCodeInterpreterCommand({
          codeInterpreterIdentifier: BUILT_IN, sessionId, name: "executeCode",
          arguments: { language: "python", code: "print(6*7)" },
        })), 60_000, "run code");
        let text = "";
        for await (const ev of res.stream ?? []) {
          for (const block of ev.result?.content ?? []) text += block.text ?? "";
        }
        assert(text.includes("42"), `output was ${JSON.stringify(text.slice(0, 200))}`);
        return `session start ${startedMs} ms, run ${Date.now() - t0 - startedMs} ms`;
      } finally {
        await client.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: BUILT_IN, sessionId })).catch(() => {});
      }
    }),
  ];
}
