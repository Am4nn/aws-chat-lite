import { Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { CoreStack } from "./core-stack.js";
import { originSecret } from "./web.js";

/** The partition keys of the items the authorization server owns. */
const OWN_ITEMS = ["OAUTHCLIENT#*", "OAUTHREQ#*", "OAUTHCODE#*", "OAUTHGRANT#*", "RATE#oauth#*"];

/** The issuer MCP clients see, which every OAuth and MCP URL is built on, and the site that holds the consent page. */
export const issuerEnvironment = (stack: CoreStack) => ({ MCP_BASE_URL: stack.publicApiUrl, SITE_URL: stack.stageConfig.siteOrigins[0]! });

/**
 * chat-lite's OAuth authorization server, so MCP clients can sign in as a chat-lite user: one Lambda. Discovery,
 * registration, authorize, token and revoke are public, because the clients that call them have no chat-lite session
 * yet; the consent page's request and decision and the Connected apps routes sit behind the JWT authorizer. There is
 * no CORS: MCP clients call from servers and apps, never from a browser page.
 *
 * Its routes are public, so its table access is limited to its own items by their partition key. The Null condition
 * stops a request without a key from passing ForAllValues trivially. The apps list reads gsi1, whose queries the
 * condition doesn't cover; that index holds only room memberships and app grants (token hashes, never tokens), and is
 * read-only here. It may look users up, so a refresh can end the grant of a deleted or disabled account.
 */
export function addOAuth(stack: CoreStack) {
  const { table, auth } = stack;
  const fn = stack.addFunction("oauth", "oauth/handler.ts", {}, {
    timeout: Duration.seconds(15),
    // Its rate limits count each viewer's address, which only requests carrying CloudFront's secret can vouch for.
    environment: {
      ...issuerEnvironment(stack), USER_POOL_ID: auth.userPool.userPoolId,
      ...(!stack.stageConfig.isLocal && { ORIGIN_VERIFY_SECRET: originSecret(stack) }),
    },
  });
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"],
    resources: [table.tableArn],
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": OWN_ITEMS }, Null: { "dynamodb:LeadingKeys": "false" } },
  }));
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:Query"], resources: [`${table.tableArn}/index/gsi1`] }));
  auth.userPool.grant(fn, "cognito-idp:AdminGetUser");
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
