import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

type Options = {
  /** 0 picks a free port. */
  port?: number;
  /** Where its MCP and OAuth endpoints are reached from; defaults to http://127.0.0.1:<port>. */
  origin?: string;
  /** Where a browser reaches the authorize page, when that differs from `origin` (a container's host name). */
  publicOrigin?: string;
  accessTtlSec?: number;
  consent?: "allow" | "deny";
  auth?: "oauth" | "none";
  registration?: boolean;
  extraTools?: number;
  metadataOverrides?: Record<string, string>;
};

type Call = { tool: string; input: Record<string, unknown>; sub?: string };

const TEXT_INPUT = { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"] };
const NO_INPUT = { type: "object" as const, properties: {} };
const READ_ONLY = { readOnlyHint: true };

const newToken = (kind: string) => `${kind}-${randomBytes(16).toString("base64url")}`;
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const text = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }] });

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A remote MCP server with its own OAuth authorization server (discovery, registration, PKCE, refresh rotation and
 * revocation), so the MCP client can be tested end to end without calling anything outside this machine. It binds
 * 127.0.0.1 only and keeps everything in memory.
 */
export async function startMcpTestServer({
  port = 0,
  origin: givenOrigin,
  publicOrigin: givenPublicOrigin,
  accessTtlSec = 3600,
  consent = "allow",
  auth = "oauth",
  registration = true,
  extraTools = 0,
  metadataOverrides = {},
}: Options = {}) {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  const accessExpiry = new Map<string, number>();
  const refreshClient = new Map<string, string>();
  let notes = 0;

  const tools: Tool[] = [
    { name: "echo", description: "Repeats the text.", inputSchema: TEXT_INPUT, annotations: READ_ONLY },
    { name: "add_note", description: "Saves a note.", inputSchema: TEXT_INPUT },
    { name: "whoami", description: "Says who signed in.", inputSchema: NO_INPUT, annotations: READ_ONLY },
    { name: "fail", description: "Always fails.", inputSchema: NO_INPUT, annotations: READ_ONLY },
    ...Array.from({ length: extraTools }, (_, i) => ({
      name: `tool_${i + 1}`,
      description: `Extra tool ${i + 1}.`,
      inputSchema: NO_INPUT,
      annotations: READ_ONLY,
    })),
  ];

  function run(name: string, input: Record<string, unknown>): CallToolResult {
    if (name === "echo") return text(`echo: ${String(input.text)}`);
    if (name === "add_note") return text(`Saved note #${++notes}.`);
    if (name === "whoami") return text("you are tester");
    if (name === "fail") return { ...text("it failed"), isError: true };
    if (tools.some((t) => t.name === name)) return text(`${name} ran.`);
    throw new Error(`There's no tool called ${name}.`);
  }

  function mcpServer(sub: string | undefined) {
    const server = new Server({ name: "chat-lite-test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      const input = params.arguments ?? {};
      test.calls.push({ tool: params.name, input, sub });
      return run(params.name, input);
    });
    return server;
  }

  function issue(clientId: string) {
    const access = newToken("at");
    const refresh = newToken("rt");
    accessExpiry.set(access, Date.now() + accessTtlSec * 1000);
    refreshClient.set(refresh, clientId);
    return { access_token: access, token_type: "Bearer", expires_in: accessTtlSec, refresh_token: refresh, scope: "notes" };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", origin);
    const route = `${req.method} ${url.pathname}`;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    const invalidGrant = () => json(400, { error: "invalid_grant" });

    if (route === "GET /.well-known/oauth-protected-resource" || route === "GET /.well-known/oauth-protected-resource/mcp") {
      return json(200, { resource: test.url, authorization_servers: [origin], scopes_supported: ["notes"] });
    }
    if (route === "GET /.well-known/oauth-authorization-server") return json(200, metadata);

    if (route === "POST /register" && registration) {
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
      const clientId = newToken("client");
      clients.set(clientId, body.redirect_uris ?? []);
      test.registrations++;
      return json(201, { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none" });
    }

    if (route === "GET /authorize") {
      const q = url.searchParams;
      const clientId = q.get("client_id") ?? "";
      const redirectUri = q.get("redirect_uri") ?? "";
      const challenge = q.get("code_challenge");
      // An unknown client or redirect gets an error page, never a redirect, so the server can't be used as an open redirector.
      if (!clients.get(clientId)?.includes(redirectUri)) return json(400, { error: "invalid_request" });
      const back = new URL(redirectUri);
      if (consent === "deny") back.searchParams.set("error", "access_denied");
      else if (!challenge || q.get("code_challenge_method") !== "S256") back.searchParams.set("error", "invalid_request");
      else {
        const code = newToken("code");
        codes.set(code, { clientId, redirectUri, challenge });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", q.get("state") ?? "");
      back.searchParams.set("iss", origin);
      return res.writeHead(302, { location: back.href }).end();
    }

    if (route === "POST /token") {
      const form = new URLSearchParams(await readBody(req));
      const clientId = form.get("client_id");
      if (form.get("grant_type") === "authorization_code") {
        const key = form.get("code") ?? "";
        const code = codes.get(key);
        codes.delete(key);
        if (!code || code.clientId !== clientId || code.redirectUri !== form.get("redirect_uri")) return invalidGrant();
        if (s256(form.get("code_verifier") ?? "") !== code.challenge) return invalidGrant();
        return json(200, issue(code.clientId));
      }
      if (form.get("grant_type") === "refresh_token") {
        const key = form.get("refresh_token") ?? "";
        const owner = refreshClient.get(key);
        refreshClient.delete(key);
        if (!owner || owner !== clientId) return invalidGrant();
        test.refreshes++;
        return json(200, issue(owner));
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    if (route === "POST /revoke") {
      const token = new URLSearchParams(await readBody(req)).get("token") ?? "";
      accessExpiry.delete(token);
      refreshClient.delete(token);
      return res.writeHead(200).end();
    }

    if (route === "POST /mcp") {
      if (auth === "oauth") {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        if (!((accessExpiry.get(bearer) ?? 0) > Date.now())) {
          return json(401, { error: "invalid_token" }, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="notes"`,
          });
        }
      }
      // Stateless: a fresh server and transport for every request, and no session to resume.
      const server = mcpServer(auth === "oauth" ? "tester" : undefined);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      res.on("close", () => void server.close());
      return transport.handleRequest(req, res);
    }
    if (url.pathname === "/mcp") return json(405, { error: "Only POST." }, { allow: "POST" });

    json(404, { error: "not_found" });
  }

  const listener = http.createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "server_error", error_description: e.message }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });

  const origin = givenOrigin ?? `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const metadata = {
    issuer: origin,
    authorization_endpoint: `${givenPublicOrigin ?? origin}/authorize`,
    token_endpoint: `${origin}/token`,
    ...(registration && { registration_endpoint: `${origin}/register` }),
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["notes"],
    ...metadataOverrides,
  };
  const test = {
    url: `${origin}/mcp`,
    origin,
    calls: [] as Call[],
    registrations: 0,
    refreshes: 0,
    revokeAll() {
      accessExpiry.clear();
      refreshClient.clear();
    },
    close() {
      listener.closeAllConnections();
      return new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
  return test;
}
