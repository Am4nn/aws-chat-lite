import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { makeHandler } from "./handler.js";
import { oauthRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1", MCP_BASE_URL: "https://api.example", SITE_URL: "https://site.example" });

afterEach(() => vi.restoreAllMocks());

const client = { clientId: "c1", clientName: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"], ttl: Math.floor(Date.now() / 1000) + 999 };

function fakeTable(items: Record<string, object> = {}) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof UpdateCommand) return { Attributes: { n: 1 } };
    if (c instanceof GetCommand) return { Item: items[String(c.input.Key?.pk)] };
    return {};
  }) as never);
}

const ev = (routeKey: string, over: object = {}) => ({
  routeKey, requestContext: { http: { sourceIp: "1.2.3.4" }, authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } }, ...over,
}) as any;

const handle = (routeKey: string, over?: object) => makeHandler(oauthRepo())(ev(routeKey, over));

const authorize = (q: Record<string, string>) => handle("GET /oauth/authorize", {
  queryStringParameters: {
    client_id: "c1", redirect_uri: client.redirectUris[0], response_type: "code", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256", state: "st", resource: "https://api.example/mcp", ...q,
  },
});

describe("GET /oauth/authorize", () => {
  it("an unknown client is a plain 400 that never redirects", async () => {
    fakeTable();
    const res = await authorize({});
    expect(res.statusCode).toBe(400);
    expect(res.headers?.location).toBeUndefined();
  });

  it("an unregistered redirect URI is a plain 400 too", async () => {
    fakeTable({ "OAUTHCLIENT#c1": client });
    const res = await authorize({ redirect_uri: "https://evil.example/cb" });
    expect(res.statusCode).toBe(400);
    expect(res.headers?.location).toBeUndefined();
  });

  it("a valid request goes to the consent page", async () => {
    fakeTable({ "OAUTHCLIENT#c1": client });
    const res = await authorize({});
    expect(res.statusCode).toBe(302);
    expect(String(res.headers?.location)).toMatch(/^https:\/\/site\.example\/consent\?request=[A-Za-z0-9_-]{22}$/);
  });

  it.each([
    [{ scope: "admin" }, "invalid_scope"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ resource: "https://other/mcp" }, "invalid_target"],
  ])("other faults go back to the client: %j → %s", async (q, error) => {
    fakeTable({ "OAUTHCLIENT#c1": client });
    const res = await authorize(q);
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers?.location));
    expect([url.origin + url.pathname, url.searchParams.get("error"), url.searchParams.get("state"), url.searchParams.get("iss")])
      .toEqual([client.redirectUris[0], error, "st", "https://api.example"]);
  });
});

describe("POST /oauth/token", () => {
  it("errors are RFC 6749 JSON with no-store, and a base64 form is decoded", async () => {
    fakeTable();
    const res = await handle("POST /oauth/token", { body: Buffer.from("grant_type=password").toString("base64"), isBase64Encoded: true });
    expect(res.statusCode).toBe(400);
    expect(res.headers).toMatchObject({ "cache-control": "no-store", "content-type": "application/json" });
    expect(JSON.parse(String(res.body))).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("an unknown code is invalid_grant", async () => {
    fakeTable();
    const res = await handle("POST /oauth/token", { body: "grant_type=authorization_code&code=cl_code_x&client_id=c1" });
    expect(JSON.parse(String(res.body))).toMatchObject({ error: "invalid_grant" });
  });
});

describe("the other public routes", () => {
  it("serve both metadata documents", async () => {
    expect(JSON.parse(String((await handle("GET /.well-known/oauth-authorization-server")).body))).toMatchObject({ issuer: "https://api.example" });
    for (const route of ["GET /.well-known/oauth-protected-resource", "GET /.well-known/oauth-protected-resource/mcp"]) {
      expect(JSON.parse(String((await handle(route)).body))).toMatchObject({ resource: "https://api.example/mcp" });
    }
  });

  it("register answers 201; a body that isn't JSON is invalid_client_metadata", async () => {
    fakeTable();
    expect((await handle("POST /oauth/register", { body: JSON.stringify({ redirect_uris: ["https://x.com/cb"] }) })).statusCode).toBe(201);
    const bad = await handle("POST /oauth/register", { body: "{" });
    expect([bad.statusCode, JSON.parse(String(bad.body)).error]).toEqual([400, "invalid_client_metadata"]);
  });

  it("revoke always succeeds", async () => {
    fakeTable();
    expect((await handle("POST /oauth/revoke", { body: "token=nonsense" })).statusCode).toBe(200);
  });
});

describe("the signed-in routes", () => {
  it("a used or expired request is a 404 with the consent copy, both to read and to decide", async () => {
    fakeTable({ "OAUTHREQ#r1": { clientName: "Claude", redirectUri: client.redirectUris[0], scopes: ["rooms:read"], ttl: Math.floor(Date.now() / 1000) - 1 } });
    const read = await handle("GET /oauth/requests/{requestId}", { pathParameters: { requestId: "r1" } });
    expect([read.statusCode, JSON.parse(String(read.body)).error]).toEqual([404, "This sign-in request expired. Start again from your app."]);
    vi.restoreAllMocks();
    vi.spyOn(docClient(), "send").mockRejectedValue(Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" }) as never);
    const decided = await handle("POST /oauth/requests/{requestId}/decision", { pathParameters: { requestId: "r1" }, body: JSON.stringify({ decision: "allow" }) });
    expect([decided.statusCode, JSON.parse(String(decided.body)).error]).toEqual([404, "This sign-in request expired. Start again from your app."]);
  });

  it("a request shows the client, where it goes back to and the scopes", async () => {
    const ttl = Math.floor(Date.now() / 1000) + 300;
    fakeTable({ "OAUTHREQ#r1": { clientName: "Claude", redirectUri: client.redirectUris[0], scopes: ["rooms:read"], ttl } });
    const res = await handle("GET /oauth/requests/{requestId}", { pathParameters: { requestId: "r1" } });
    expect(JSON.parse(String(res.body))).toEqual({ clientName: "Claude", redirectHost: "claude.ai", scopes: ["rooms:read"], expiresAt: new Date(ttl * 1000).toISOString() });
  });

  it("a decision must be allow or deny", async () => {
    fakeTable();
    const res = await handle("POST /oauth/requests/{requestId}/decision", { pathParameters: { requestId: "r1" }, body: JSON.stringify({ decision: "maybe" }) });
    expect(res.statusCode).toBe(400);
  });
});
