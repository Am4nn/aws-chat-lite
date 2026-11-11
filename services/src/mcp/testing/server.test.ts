import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthorizationServerMetadata, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpTestServer } from "./server.js";

const REDIRECT = "http://localhost:3000/bff/mcp/callback";
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(o?: Parameters<typeof startMcpTestServer>[0]) {
  const server = await startMcpTestServer(o);
  servers.push(server);
  return server;
}

async function signIn(server: Awaited<ReturnType<typeof start>>) {
  const info = await discoverOAuthServerInfo(server.url);
  const metadata = info.authorizationServerMetadata!;
  const client = await registerClient(info.authorizationServerUrl, {
    metadata,
    clientMetadata: { client_name: "chat-lite", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
  });
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: REDIRECT,
    scope: "notes",
    state: "s1",
    resource: server.url,
  });
  const redirect = await fetch(authorizationUrl, { redirect: "manual" });
  return { info, metadata, client, codeVerifier, redirect };
}

const exchange = (o: { metadata: AuthorizationServerMetadata; client: OAuthClientInformationFull; code: string; codeVerifier: string }) =>
  exchangeAuthorization(o.metadata.issuer, {
    metadata: o.metadata,
    clientInformation: o.client,
    authorizationCode: o.code,
    codeVerifier: o.codeVerifier,
    redirectUri: REDIRECT,
  });

async function connect(url: string, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const mcpStatus = (url: string, token?: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }).then((r) => r.status);

async function tokensFor(server: Awaited<ReturnType<typeof start>>) {
  const s = await signIn(server);
  const code = new URL(s.redirect.headers.get("location")!).searchParams.get("code")!;
  return { ...s, tokens: await exchange({ ...s, code }) };
}

describe("the test server's OAuth", () => {
  it("is discoverable and registers clients", async () => {
    const server = await start();
    const { info, client } = await signIn(server);
    expect(info.authorizationServerUrl).toBe(server.origin);
    expect(info.authorizationServerMetadata!.code_challenge_methods_supported).toEqual(["S256"]);
    expect(info.authorizationServerMetadata!.registration_endpoint).toBe(`${server.origin}/register`);
    expect(client.client_id).toMatch(/^client-/);
    expect(server.registrations).toBe(1);
  });

  it("sends the browser to the public origin and everything else to the origin", async () => {
    const server = await start({ publicOrigin: "http://localhost:9" });
    const info = await discoverOAuthServerInfo(server.url);
    expect(info.authorizationServerMetadata!.authorization_endpoint).toBe("http://localhost:9/authorize");
    expect(info.authorizationServerMetadata!.token_endpoint).toBe(`${server.origin}/token`);
  });

  it("checks PKCE and uses a code only once", async () => {
    const server = await start();
    const s = await signIn(server);
    expect(s.redirect.status).toBe(302);
    const back = new URL(s.redirect.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("iss")).toBe(server.origin);
    const code = back.searchParams.get("code")!;
    await expect(exchange({ ...s, code, codeVerifier: "wrong".repeat(10) })).rejects.toMatchObject({ errorCode: "invalid_grant" });
    // A wrong verifier spends the code, as a real server would.
    await expect(exchange({ ...s, code })).rejects.toMatchObject({ errorCode: "invalid_grant" });

    const again = await signIn(server);
    const second = new URL(again.redirect.headers.get("location")!).searchParams.get("code")!;
    const tokens = await exchange({ ...again, code: second });
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "notes" });
    await expect(exchange({ ...again, code: second })).rejects.toMatchObject({ errorCode: "invalid_grant" });
  });

  it("answers access_denied when consent is refused", async () => {
    const server = await start({ consent: "deny" });
    const back = new URL((await signIn(server)).redirect.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.has("code")).toBe(false);
  });

  it("rotates refresh tokens and refuses a used one", async () => {
    const server = await start();
    const { metadata, client, tokens } = await tokensFor(server);
    const refresh = () => refreshAuthorization(metadata.issuer, { metadata, clientInformation: client, refreshToken: tokens.refresh_token! });
    const next = await refresh();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(server.refreshes).toBe(1);
    await expect(refresh()).rejects.toMatchObject({ errorCode: "invalid_grant" });
    expect(await mcpStatus(server.url, next.access_token)).toBe(200);
  });

  it("revokes a token", async () => {
    const server = await start();
    const { metadata, tokens } = await tokensFor(server);
    expect(metadata).toMatchObject({ revocation_endpoint: `${server.origin}/revoke` });
    const res = await fetch(`${server.origin}/revoke`, { method: "POST", body: new URLSearchParams({ token: tokens.access_token }) });
    expect(res.status).toBe(200);
    expect(await mcpStatus(server.url, tokens.access_token)).toBe(401);
  });

  it("can refuse registration", async () => {
    const server = await start({ registration: false });
    const info = await discoverOAuthServerInfo(server.url);
    expect(info.authorizationServerMetadata!.registration_endpoint).toBeUndefined();
  });

  it("applies metadata overrides", async () => {
    const server = await start({ metadataOverrides: { token_endpoint: "http://169.254.169.254/token" } });
    const info = await discoverOAuthServerInfo(server.url);
    expect(info.authorizationServerMetadata!.token_endpoint).toBe("http://169.254.169.254/token");
  });
});

describe("the test server's MCP endpoint", () => {
  it("asks for a bearer token, pointing at its resource metadata", async () => {
    const server = await start();
    const res = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${server.origin}/.well-known/oauth-protected-resource/mcp", scope="notes"`,
    );
    const prm = await (await fetch(`${server.origin}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toEqual({ resource: server.url, authorization_servers: [server.origin], scopes_supported: ["notes"] });
  });

  it("lists and runs its tools, recording each call", async () => {
    const server = await start({ extraTools: 2 });
    const client = await connect(server.url, (await tokensFor(server)).tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "add_note", "whoami", "fail", "tool_1", "tool_2"]);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(tools[1]!.annotations).toBeUndefined();
    expect(await client.callTool({ name: "echo", arguments: { text: "hi" } })).toEqual({ content: [{ type: "text", text: "echo: hi" }] });
    expect(await client.callTool({ name: "add_note", arguments: { text: "a" } })).toEqual({ content: [{ type: "text", text: "Saved note #1." }] });
    expect(await client.callTool({ name: "whoami", arguments: {} })).toEqual({ content: [{ type: "text", text: "you are tester" }] });
    expect(await client.callTool({ name: "fail", arguments: {} })).toEqual({ content: [{ type: "text", text: "it failed" }], isError: true });
    expect(server.calls).toEqual([
      { tool: "echo", input: { text: "hi" }, sub: "tester" },
      { tool: "add_note", input: { text: "a" }, sub: "tester" },
      { tool: "whoami", input: {}, sub: "tester" },
      { tool: "fail", input: {}, sub: "tester" },
    ]);
    await client.close();
  });

  it("needs no token when auth is none", async () => {
    const server = await start({ auth: "none" });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    expect((await client.listTools()).tools).toHaveLength(4);
    await client.close();
  });

  it("expires access tokens", async () => {
    const server = await start({ accessTtlSec: 1 });
    const { tokens } = await tokensFor(server);
    expect(tokens.expires_in).toBe(1);
    expect(await mcpStatus(server.url, tokens.access_token)).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await mcpStatus(server.url, tokens.access_token)).toBe(401);
  });

  it("revokeAll signs everyone out", async () => {
    const server = await start();
    const { tokens } = await tokensFor(server);
    server.revokeAll();
    expect(await mcpStatus(server.url, tokens.access_token)).toBe(401);
  });

  it("refuses GET and DELETE, since it keeps no sessions", async () => {
    const server = await start({ auth: "none" });
    expect((await fetch(server.url)).status).toBe(405);
    expect((await fetch(server.url, { method: "DELETE" })).status).toBe(405);
  });
});
