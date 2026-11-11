import { Duration } from "aws-cdk-lib";
import type { CoreStack } from "./core-stack.js";

/** The issuer MCP clients see, which every OAuth and MCP URL is built on, and the site that holds the consent page. */
export const issuerEnvironment = (stack: CoreStack) => ({ MCP_BASE_URL: stack.publicApiUrl, SITE_URL: stack.stageConfig.siteOrigins[0]! });

/**
 * chat-lite's OAuth authorization server, so MCP clients can sign in as a chat-lite user: one Lambda. Discovery,
 * registration, authorize, token and revoke are public, because the clients that call them have no chat-lite session
 * yet; the consent page's request and decision and the Connected apps routes sit behind the JWT authorizer. There is
 * no CORS: MCP clients call from servers and apps, never from a browser page.
 */
export function addOAuth(stack: CoreStack) {
  const fn = stack.addFunction("oauth", "oauth/handler.ts", { tableAccess: true }, {
    timeout: Duration.seconds(15),
    environment: issuerEnvironment(stack),
  });
  const open = { public: true };
  stack.route("GET", "/.well-known/oauth-authorization-server", fn, open);
  stack.route("GET", "/.well-known/oauth-protected-resource", fn, open);
  stack.route("GET", "/.well-known/oauth-protected-resource/mcp", fn, open);
  stack.route("POST", "/oauth/register", fn, open);
  stack.route("GET", "/oauth/authorize", fn, open);
  stack.route("POST", "/oauth/token", fn, open);
  stack.route("POST", "/oauth/revoke", fn, open);
  stack.route("GET", "/oauth/requests/{requestId}", fn);
  stack.route("POST", "/oauth/requests/{requestId}/decision", fn);
  stack.route("GET", "/me/apps", fn);
  stack.route("DELETE", "/me/apps/{grantId}", fn);
}
