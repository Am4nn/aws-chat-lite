import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { chatRepo } from "../../chat/repo.js";
import type { User } from "../../lib/auth.js";
import { oauthRepo } from "../../oauth/repo.js";
import { roomsRepo } from "../../rooms/repo.js";

// Runs against the deployed OAuth and MCP Lambdas on Floci, over its HTTP API: npm run deploy:local, then this file.
const outputs = JSON.parse(readFileSync(new URL("../../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
const BASE = String(outputs["cl-local-core"].McpBaseUrl);
Object.assign(process.env, { MCP_BASE_URL: BASE, SITE_URL: "http://localhost:3000" });

const REDIRECT = "http://127.0.0.1:33418/callback";
const user = (name: string): User => ({ userId: randomUUID(), username: name });
const get = (path: string, init?: RequestInit) => fetch(`${BASE}${path}`, init);

/** Registration, authorize and the token exchange over HTTP, as an MCP client does them; consent through the repo. */
async function signIn(who: User) {
  const registered = await get("/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Int test" }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = await registered.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code", state: "st", resource: `${BASE}/mcp`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  const authorized = await get(`/oauth/authorize?${query}`, { redirect: "manual" });
  expect(authorized.status).toBe(302);
  const consent = authorized.headers.get("location")!;
  expect(consent).toMatch(/^http:\/\/localhost:3000\/consent\?request=/);
  const { redirectTo } = await oauthRepo().decide(who, new URL(consent).searchParams.get("request")!, "allow");
  const token = await get("/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: new URL(redirectTo).searchParams.get("code")!, client_id: clientId,
      redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return (await token.json() as { access_token: string }).access_token;
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: "int-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  return client;
}

const textOf = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const listTools = (token: string, headers: Record<string, string> = {}) => get("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

describe("chat-lite as an MCP server, on Floci", () => {
  it("publishes both metadata documents on the public base", async () => {
    const as = await (await get("/.well-known/oauth-authorization-server")).json();
    expect(as).toMatchObject({ issuer: BASE, code_challenge_methods_supported: ["S256"], token_endpoint: `${BASE}/oauth/token` });
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(await (await get(path)).json(), path).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    }
  });

  it("signs in through OAuth, then lists, posts and starts a thread as the user; a revoked app is out at once", async () => {
    const aman = user("aman");
    const rooms = roomsRepo();
    const { roomId, generalChatId } = await rooms.createRoom(aman, "MCP");
    const token = await signIn(aman);
    const client = await mcpClient(token);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["list_rooms", "list_room", "read_messages", "post_message", "start_thread"]);
    expect(textOf(await client.callTool({ name: "post_message", arguments: { room: roomId, chat: "general", text: "deploy done" } }))).toMatch(/^Posted to #general/);
    const { messages } = await chatRepo().history(aman, roomId, generalChatId, {});
    expect(messages.at(-1)).toMatchObject({ text: "deploy done", authorId: aman.userId });

    await client.callTool({ name: "post_message", arguments: { room: roomId, chat: "general", text: "@agent hi" } });
    expect((await rooms.getRoomView(roomId, aman.userId)).threads).toHaveLength(1);

    const [app] = await oauthRepo().listApps(aman.userId);
    await oauthRepo().revokeApp(aman.userId, app!.grantId);
    expect((await listTools(token)).status).toBe(401);
    await client.close();
  });

  it("someone removed from a room loses it on their next call", async () => {
    const aman = user("aman");
    const bea = user("bea");
    const rooms = roomsRepo();
    const { roomId } = await rooms.createRoom(aman, "Removal");
    await rooms.acceptInvite((await rooms.rotateInvite(roomId, aman.userId)).code, bea);
    const client = await mcpClient(await signIn(bea));
    const read = () => client.callTool({ name: "read_messages", arguments: { room: roomId, chat: "general" } });
    expect((await read()).isError).toBeFalsy();

    await rooms.removeMember(roomId, aman.userId, bea.userId);
    const refused = await read();
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^No room/);
    await client.close();
  });

  it("without a token, says where to sign in; a browser on another site is refused", async () => {
    const res = await get("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect((await listTools("x", { origin: "https://evil.example" })).status).toBe(403);
  });
});
