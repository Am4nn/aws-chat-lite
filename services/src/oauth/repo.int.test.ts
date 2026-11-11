import { describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { NotFound } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { oauthRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
Object.assign(process.env, { MCP_BASE_URL: "http://api.test", SITE_URL: "http://localhost:3000" });

// These users exist only in this file; the Cognito check is pinned in lib/users.int.test.ts.
const repo = oauthRepo(async () => true);
const RESOURCE = "http://api.test/mcp";
// A fresh address per call, so these tests never share a rate-limit window.
const ip = () => `test-${randomUUID()}`;
type Tokens = { access_token: string; refresh_token: string; scope: string };

/** Registers a native client, then signs `user` in through authorize and consent, up to the code. */
async function signIn(scope?: string) {
  const user = { userId: randomUUID(), username: "aman" };
  const { client_id: clientId } = await repo.registerClient({ redirect_uris: ["http://127.0.0.1:1/callback"], client_name: "Claude Code" }, ip()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = "http://127.0.0.1:33418/callback";
  const started = await repo.startRequest({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", state: "st", resource: RESOURCE, scope,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  }, ip());
  if (!("consent" in started)) throw new Error(`authorize refused: ${JSON.stringify(started)}`);
  const requestId = new URL(started.consent).searchParams.get("request")!;
  const request = await repo.getRequest(requestId);
  const { redirectTo } = await repo.decide(user, requestId, "allow");
  return { user, clientId, verifier, redirectUri, requestId, request, code: new URL(redirectTo).searchParams.get("code")! };
}

type SignIn = Awaited<ReturnType<typeof signIn>>;

const exchange = async (s: SignIn, over: Record<string, string> = {}) => await repo.token(new URLSearchParams({
  grant_type: "authorization_code", code: s.code, client_id: s.clientId, redirect_uri: s.redirectUri, code_verifier: s.verifier, resource: RESOURCE, ...over,
})) as Tokens;

const refresh = async (s: SignIn, token: string) =>
  await repo.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: s.clientId })) as Tokens;

describe("OAuth authorization server on Floci", () => {
  it("code → tokens → refresh; the request is used once, and a rotated pair replaces the old one", async () => {
    const s = await signIn();
    expect(s.request).toMatchObject({ clientName: "Claude Code", redirectHost: "127.0.0.1:33418", scopes: ["rooms:read", "rooms:write"] });
    await expect(repo.getRequest(s.requestId)).rejects.toBeInstanceOf(NotFound);
    await expect(repo.decide(s.user, s.requestId, "allow")).rejects.toBeInstanceOf(NotFound);

    const first = await exchange(s);
    expect(first.scope).toBe("rooms:read rooms:write");
    expect(await repo.verifyAccess(first.access_token)).toMatchObject({ user: s.user, scopes: ["rooms:read", "rooms:write"] });

    const second = await refresh(s, first.refresh_token);
    expect(await repo.verifyAccess(second.access_token)).toMatchObject({ user: s.user });
    expect(await repo.verifyAccess(first.access_token)).toBeNull();
  });

  it("a code used twice is invalid_grant, and the grant the first use made is revoked", async () => {
    const s = await signIn();
    const first = await exchange(s);
    await expect(exchange(s)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await repo.verifyAccess(first.access_token)).toBeNull();
  });

  it("a rotated refresh token presented again after the grace is invalid_grant, and the newest tokens die with the grant", async () => {
    const s = await signIn();
    const first = await exchange(s);
    const second = await refresh(s, first.refresh_token);
    const [app] = await repo.listApps(s.user.userId);
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `OAUTHGRANT#${app!.grantId}`, sk: "META" }, UpdateExpression: "SET rotatedAt = :then",
      ExpressionAttributeValues: { ":then": Math.floor(Date.now() / 1000) - 60 },
    }));
    await expect(refresh(s, first.refresh_token)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await repo.verifyAccess(second.access_token)).toBeNull();
    await expect(refresh(s, second.refresh_token)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("one client refreshing twice at once keeps its grant: one refresh wins, the other is refused", async () => {
    const s = await signIn();
    const first = await exchange(s);
    const answers = await Promise.allSettled([refresh(s, first.refresh_token), refresh(s, first.refresh_token)]);
    const won = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
    expect(won).toHaveLength(1);
    expect(answers.find((a) => a.status === "rejected")).toMatchObject({ reason: { code: "invalid_grant" } });
    expect(await repo.verifyAccess(won[0]!.access_token)).toMatchObject({ user: s.user });
    await expect(refresh(s, first.refresh_token)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await repo.verifyAccess(won[0]!.access_token)).not.toBeNull();
    expect(await refresh(s, won[0]!.refresh_token)).toMatchObject({ token_type: "Bearer" });
  });

  it("a wrong verifier, another redirect_uri or another resource is refused, and the code still works after", async () => {
    const s = await signIn("rooms:read");
    await expect(exchange(s, { code_verifier: randomBytes(32).toString("base64url") })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchange(s, { redirect_uri: "http://127.0.0.1:33418/other" })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchange(s, { resource: "https://other/mcp" })).rejects.toMatchObject({ code: "invalid_target" });
    expect((await exchange(s)).scope).toBe("rooms:read");
  });

  it("an app appears in Connected apps, not among rooms; only its owner removes it, and its token dies at once", async () => {
    const s = await signIn();
    const tokens = await exchange(s);
    await roomsRepo().createRoom(s.user, "Ops");
    const [app, ...others] = await repo.listApps(s.user.userId);
    expect(others).toEqual([]);
    expect(app).toMatchObject({ clientName: "Claude Code", scopes: ["rooms:read", "rooms:write"] });
    expect((await roomsRepo().listMyRooms(s.user.userId)).map((r) => r.name)).toEqual(["Ops"]);

    await expect(repo.revokeApp(randomUUID(), app.grantId)).rejects.toBeInstanceOf(NotFound);
    expect(await repo.verifyAccess(tokens.access_token)).not.toBeNull();
    await repo.revokeApp(s.user.userId, app.grantId);
    expect(await repo.verifyAccess(tokens.access_token)).toBeNull();
    expect(await repo.listApps(s.user.userId)).toEqual([]);
  });

  it("revoking either token ends the grant", async () => {
    const s = await signIn();
    const tokens = await exchange(s);
    await repo.revoke(new URLSearchParams({ token: tokens.refresh_token }));
    expect(await repo.verifyAccess(tokens.access_token)).toBeNull();
  });

  it("the 21st registration from one address within the hour is slow_down", async () => {
    const from = ip();
    for (let i = 0; i < 20; i++) await repo.registerClient({ redirect_uris: ["https://x.example/cb"] }, from);
    await expect(repo.registerClient({ redirect_uris: ["https://x.example/cb"] }, from)).rejects.toMatchObject({ code: "slow_down", status: 429 });
  });
});
