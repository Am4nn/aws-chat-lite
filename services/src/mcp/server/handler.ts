import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chatRepo } from "../../chat/repo.js";
import { DEFAULT_ERROR, UserError } from "../../lib/errors.js";
import { json } from "../../lib/http.js";
import { broadcastToRoom } from "../../live/broadcast.js";
import { issuer, siteUrl } from "../../oauth/model.js";
import { oauthRepo, type OAuthRepo } from "../../oauth/repo.js";
import { roomsRepo } from "../../rooms/repo.js";
import { routeSend } from "../../threads/route.js";
import { startThread } from "../../threads/start-thread.js";
import { fromResponse, toRequest } from "./adapter.js";
import { toolsForScopes, type ServerDeps } from "./tools.js";

type Result = APIGatewayProxyStructuredResultV2;

const INSTRUCTIONS = "chat-lite rooms: people chats and agent threads. Messages you post appear under your own name.";

const textResult = (text: string, isError?: true): CallToolResult => ({ ...(isError && { isError }), content: [{ type: "text", text }] });

/** RFC 6750's challenge, pointing the client at the metadata that says where to sign in (RFC 9728). */
function unauthorized(tokenSent: boolean): Result {
  const challenge = `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp", scope="rooms:read rooms:write"`;
  const res = json(401, { error: tokenSent ? "This app's sign-in has ended. Sign in again." : "Sign in to chat-lite first." });
  return { ...res, headers: { ...res.headers, "www-authenticate": tokenSent ? `${challenge}, error="invalid_token"` : challenge } };
}

/**
 * chat-lite's MCP endpoint, stateless Streamable HTTP: every POST carries its bearer token, and a fresh server and
 * transport answer it, so any Lambda instance can serve any request and nothing outlives it.
 */
export function makeMcpHandler(verify: OAuthRepo["verifyAccess"], deps: ServerDeps) {
  return async (event: APIGatewayProxyEventV2): Promise<Result> => {
    // Without sessions there is no stream to open with GET and no session to end with DELETE.
    if (event.requestContext.http.method !== "POST") return { statusCode: 405, headers: { allow: "POST" } };
    // MCP clients call from servers and apps, which send no Origin. A browser page does, and one on another site could
    // be riding a token it was handed (DNS rebinding included), so only chat-lite's own site may.
    const origin = event.headers.origin;
    if (origin && origin !== deps.siteUrl) return json(403, { error: "Browsers on other sites can't call chat-lite's MCP endpoint." });
    const token = /^Bearer (\S+)$/i.exec(event.headers.authorization ?? "")?.[1];
    const access = token ? await verify(token) : null;
    if (!access) return unauthorized(Boolean(token));

    const tools = toolsForScopes(access.scopes);
    const server = new Server({ name: "chat-lite", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return textResult(`This app can't use ${params.name}.`, true);
      try {
        return textResult(await tool.run(access.user, params.arguments ?? {}, deps));
      } catch (e) {
        // The tools already turn any other failure into a UserError with the default line, having logged it.
        return textResult(e instanceof UserError ? e.message : DEFAULT_ERROR, true);
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return fromResponse(await transport.handleRequest(toRequest(event)));
  };
}

// Built on first use, so tests can import makeMcpHandler without a table configured.
let liveHandler: ReturnType<typeof makeMcpHandler> | undefined;
export const handler = (event: APIGatewayProxyEventV2) => (liveHandler ??= makeMcpHandler(oauthRepo().verifyAccess, {
  rooms: roomsRepo(), history: chatRepo().history, send: routeSend, broadcast: broadcastToRoom, startThread, siteUrl: siteUrl(),
}))(event);
