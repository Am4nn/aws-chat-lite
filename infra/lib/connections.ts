import { Duration } from "aws-cdk-lib";
import type { CoreStack } from "./core-stack.js";

/**
 * A room's GitHub connection, approval timeout and audit log: one Lambda behind the HTTP API's JWT authorizer.
 * Finishing a GitHub sign-in makes a call per installation the admin can reach, so it gets longer than the default
 * timeout.
 */
export function addConnections(stack: CoreStack) {
  const { toolKeys, toolEnvironment } = stack.runs;
  const fn = stack.addFunction("connections", "connections/handler.ts", { tableAccess: true }, {
    timeout: Duration.seconds(15),
    // The GitHub sign-in's return address must be one of the site's own, so its code can't be handed to another site.
    environment: { ...toolEnvironment, SITE_ORIGINS: stack.stageConfig.siteOrigins.join(",") },
  });
  toolKeys.grantRead(fn);
  stack.allowBroadcast(fn);
  stack.route("GET", "/rooms/{roomId}/connections", fn);
  stack.route("GET", "/rooms/{roomId}/connections/github/installations", fn);
  stack.route("PUT", "/rooms/{roomId}/connections/github", fn);
  stack.route("DELETE", "/rooms/{roomId}/connections/github", fn);
  stack.route("POST", "/rooms/{roomId}/connections/github/sign-in", fn);
  stack.route("POST", "/github-flows/finish", fn);
  stack.route("PUT", "/rooms/{roomId}/approval-timeout", fn);
  stack.route("GET", "/rooms/{roomId}/audit", fn);
}
