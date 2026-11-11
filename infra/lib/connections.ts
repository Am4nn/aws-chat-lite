import { Duration } from "aws-cdk-lib";
import type { CoreStack } from "./core-stack.js";

/**
 * A room's GitHub connection, approval timeout and audit log: one Lambda behind the HTTP API's JWT authorizer. Listing
 * the App's installations mints a token per installation, so it gets longer than the default timeout.
 */
export function addConnections(stack: CoreStack) {
  const { toolKeys, toolEnvironment } = stack.runs;
  const fn = stack.addFunction("connections", "connections/handler.ts", { tableAccess: true }, {
    timeout: Duration.seconds(15),
    environment: toolEnvironment,
  });
  toolKeys.grantRead(fn);
  stack.allowBroadcast(fn);
  stack.route("GET", "/rooms/{roomId}/connections", fn);
  stack.route("GET", "/rooms/{roomId}/connections/github/installations", fn);
  stack.route("PUT", "/rooms/{roomId}/connections/github", fn);
  stack.route("DELETE", "/rooms/{roomId}/connections/github", fn);
  stack.route("PUT", "/rooms/{roomId}/approval-timeout", fn);
  stack.route("GET", "/rooms/{roomId}/audit", fn);
}
