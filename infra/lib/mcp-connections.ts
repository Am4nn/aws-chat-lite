import { Duration } from "aws-cdk-lib";
import type { CoreStack } from "./core-stack.js";

/**
 * Rooms' remote MCP servers: one Lambda behind the HTTP API's JWT authorizer. Connecting runs discovery,
 * registration, the token exchange and a tool listing against a server we don't control, each capped at 10 s, so it
 * gets longer than the default timeout.
 */
export function addMcpConnections(stack: CoreStack) {
  const { tokenKey, mcpEnvironment } = stack.runs;
  const fn = stack.addFunction("mcp-connections", "mcp/client/handler.ts", { tableAccess: true }, {
    timeout: Duration.seconds(30),
    // The OAuth return address must be one of the site's own, so a sign-in can't hand its code to another site.
    environment: { ...mcpEnvironment, SITE_ORIGINS: stack.stageConfig.siteOrigins.join(",") },
  });
  tokenKey.grantRead(fn);
  stack.allowBroadcast(fn);
  stack.route("POST", "/rooms/{roomId}/connections/mcp", fn);
  stack.route("POST", "/rooms/{roomId}/connections/mcp/{name}/reconnect", fn);
  stack.route("POST", "/rooms/{roomId}/connections/mcp/{name}/refresh", fn);
  stack.route("DELETE", "/rooms/{roomId}/connections/mcp/{name}", fn);
  stack.route("POST", "/mcp-flows/finish", fn);
}
