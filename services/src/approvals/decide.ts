import { LambdaClient, SendDurableExecutionCallbackSuccessCommand } from "@aws-sdk/client-lambda";
import type { User } from "../lib/auth.js";
import { approvalsRepo } from "./repo.js";

let lambda: LambdaClient | undefined;

/**
 * Wakes a run waiting on an approval. Only a wake-up: the approval item holds the decision, so a wake that fails is
 * logged and the run still reads the decision when its wait times out.
 */
export async function wakeRun(callbackId: string): Promise<void> {
  try {
    await (lambda ??= new LambdaClient({})).send(new SendDurableExecutionCallbackSuccessCommand({ CallbackId: callbackId }));
  } catch (e) {
    console.error("approval wake failed", e);
  }
}

export async function decideApproval(
  user: User, runId: string, step: number, decision: "approve" | "deny", wake = wakeRun,
): Promise<{ status: "approved" | "denied"; by: string }> {
  const { status, by, callbackId } = await approvalsRepo().decide(user, runId, step, decision);
  await wake(callbackId);
  return { status, by };
}
