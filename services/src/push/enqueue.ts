import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { bestEffort } from "../lib/best-effort.js";
import type { PushJob } from "./types.js";

let lambda: LambdaClient | undefined;

/**
 * Hands a job to the push worker with an asynchronous invoke, so a send, a run's end or an approval never waits on
 * push services. Best effort: the thing being announced has already happened, and a missed notification beats a
 * failed action.
 */
export async function enqueuePush(job: PushJob): Promise<void> {
  const FunctionName = process.env.PUSH_FN_NAME;
  if (!FunctionName || ("userIds" in job && !job.userIds.length)) return;
  await bestEffort("push enqueue", () => (lambda ??= new LambdaClient({})).send(new InvokeCommand({
    FunctionName, InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(job)),
  })));
}
