import {
  CloudFormationClient, ListStacksCommand, DeleteStackCommand, waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const BOOTSTRAP_PARAM = "/cdk-bootstrap/hnb659fds/version";

/**
 * `floci reset` wipes resources but keeps CloudFormation stack records, so CDK
 * thinks everything is deployed ("no changes"). If the bootstrap param is gone,
 * our stacks (deleted first) and CDKToolkit (last) are stale.
 * A stack of ours stuck in DELETE_FAILED is always stale: deploy would report
 * "no changes" while its resources are gone.
 */
export function staleStacks(
  stacks: { name: string; status: string }[], bootstrapParamExists: boolean,
): string[] {
  const ours = stacks.filter((s) => s.name.startsWith("cl-local-"));
  if (bootstrapParamExists) return ours.filter((s) => s.status === "DELETE_FAILED").map((s) => s.name);
  const toolkit = stacks.some((s) => s.name === "CDKToolkit") ? ["CDKToolkit"] : [];
  return [...ours.map((s) => s.name), ...toolkit];
}

/** Deletes stale stack records so bootstrap + deploy recreate everything. */
export async function cleanStaleStacks(): Promise<string[]> {
  const cfn = new CloudFormationClient({});
  const ssm = new SSMClient({});
  const exists = await ssm.send(new GetParameterCommand({ Name: BOOTSTRAP_PARAM }))
    .then(() => true, () => false);
  const { StackSummaries = [] } = await cfn.send(new ListStacksCommand({
    StackStatusFilter: [
      "CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "ROLLBACK_COMPLETE", "DELETE_FAILED",
    ],
  }));
  const stale = staleStacks(StackSummaries.map((s) => ({ name: s.StackName!, status: s.StackStatus! })), exists);
  for (const StackName of stale) {
    await cfn.send(new DeleteStackCommand({ StackName }));
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 120 }, { StackName });
  }
  return stale;
}
