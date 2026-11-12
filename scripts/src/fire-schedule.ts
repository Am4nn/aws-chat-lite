/**
 * Fires a room schedule on the local stage now, as EventBridge Scheduler would at its time:
 * `npm run schedule:fire -- <roomId> <scheduleId>`. Prints what the fire did (started, skipped, duplicate or retired).
 * It always talks to Floci, never to AWS.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { run } from "./cli.js";
import { useLocalEnv } from "./env.js";
import { assertOurFlociUp } from "./floci-owner.js";

async function main() {
  const [roomId, scheduleId] = process.argv.slice(2);
  if (!roomId || !scheduleId) throw new Error("Usage: npm run schedule:fire -- <roomId> <scheduleId>");
  await assertOurFlociUp();
  useLocalEnv();
  const res = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: "cl-local-schedule-fire", Payload: JSON.stringify({ roomId, scheduleId, at: new Date().toISOString() }),
  }));
  const reply = Buffer.from(res.Payload ?? []).toString();
  if (res.FunctionError) throw new Error(`The fire failed: ${reply}`);
  console.log(`Fired: ${JSON.parse(reply)}`);
}

run(main);
