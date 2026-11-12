import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { NotFound } from "../lib/errors.js";
import { hashOf } from "./model.js";
import { oauthRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1", MCP_BASE_URL: "https://api.example", SITE_URL: "https://site.example" });

afterEach(() => vi.restoreAllMocks());

const nowSec = () => Math.floor(Date.now() / 1000);
const grantId = "0e4a6f3c-2b1d-4c5e-9f8a-7b6c5d4e3f2a";
const conditionFailed = () => Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });

/**
 * Rate counters answer `hits`; reads answer `items` by pk; deletes fail their condition when `deleteFails`, and
 * transactions are cancelled for `transactFails`.
 */
function fakeTable(opts: { hits?: number; items?: Record<string, object>; grants?: object[]; deleteFails?: boolean; transactFails?: string } = {}) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof TransactWriteCommand && opts.transactFails) {
      throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: opts.transactFails }] });
    }
    if (c instanceof UpdateCommand && String(c.input.Key?.pk).startsWith("RATE#")) return { Attributes: { n: opts.hits ?? 1 } };
    if (c instanceof GetCommand) return { Item: opts.items?.[String(c.input.Key?.pk)] };
    if (c instanceof QueryCommand) return { Items: opts.grants ?? [] };
    if (c instanceof DeleteCommand && opts.deleteFails) throw conditionFailed();
    if (c instanceof DeleteCommand) return { Attributes: opts.items?.[String(c.input.Key?.pk)] };
    return {};
  }) as never);
}

const sent = <T,>(send: ReturnType<typeof fakeTable>, type: new (...a: never[]) => T) =>
  (send.mock.calls.map(([c]) => c) as unknown[]).filter((c): c is T => c instanceof type);

describe("registerClient", () => {
  it("registers a public client: the auth method is always none, and the name defaults", async () => {
    const send = fakeTable();
    const res = await oauthRepo().registerClient({ redirect_uris: ["http://127.0.0.1:33418/cb"], token_endpoint_auth_method: "client_secret_post" }, "1.2.3.4");
    expect(res).toMatchObject({
      client_name: "MCP client", redirect_uris: ["http://127.0.0.1:33418/cb"], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
    const [put] = sent(send, PutCommand);
    expect(put.input.Item).toMatchObject({ pk: `OAUTHCLIENT#${(res as { client_id: string }).client_id}`, redirectUris: ["http://127.0.0.1:33418/cb"] });
    expect(Number(put.input.Item?.ttl) - nowSec()).toBeGreaterThan(29 * 86400);
    expect(sent(send, UpdateCommand)[0].input.Key).toEqual({ pk: "RATE#oauth#register#1.2.3.4", sk: String(Math.floor(nowSec() / 3600)) });
  });

  it("cuts the name to 100 characters", async () => {
    fakeTable();
    const res = await oauthRepo().registerClient({ redirect_uris: ["https://x.com/cb"], client_name: "n".repeat(300) }, "1.2.3.4");
    expect((res as { client_name: string }).client_name).toHaveLength(100);
  });

  it.each([[[]], [Array(11).fill("https://x.com/cb")], [["myapp://cb"]], [undefined]])("refuses redirect_uris %j", async (uris) => {
    const send = fakeTable();
    await expect(oauthRepo().registerClient({ redirect_uris: uris }, "1.2.3.4")).rejects.toMatchObject({ code: "invalid_redirect_uri", status: 400 });
    expect(sent(send, PutCommand)).toEqual([]);
  });

  it("the 21st from one address in an hour is slow_down, and nothing is stored", async () => {
    const send = fakeTable({ hits: 21 });
    await expect(oauthRepo().registerClient({ redirect_uris: ["https://x.com/cb"] }, "1.2.3.4")).rejects.toMatchObject({ code: "slow_down", status: 429 });
    expect(sent(send, PutCommand)).toEqual([]);
  });
});

describe("decide", () => {
  const request = { redirectUri: "https://x.com/cb?keep=1", state: "s1", clientId: "c1", codeChallenge: "ch", scopes: ["rooms:read"], ttl: nowSec() + 300 };
  const user = { userId: "u1", username: "aman" };

  it("allow stores only the code's hash, bound to the user, and sends the code back with state and iss", async () => {
    const send = fakeTable({ items: { "OAUTHREQ#r1": request } });
    const { redirectTo } = await oauthRepo().decide(user, "r1", "allow");
    const url = new URL(redirectTo);
    expect([url.origin + url.pathname, url.searchParams.get("keep"), url.searchParams.get("state"), url.searchParams.get("iss")])
      .toEqual(["https://x.com/cb", "1", "s1", "https://api.example"]);
    const code = url.searchParams.get("code")!;
    const [put] = sent(send, PutCommand);
    expect(put.input.Item).toMatchObject({ pk: `OAUTHCODE#${hashOf(code)}`, userId: "u1", username: "aman", clientId: "c1", scopes: ["rooms:read"] });
    expect(JSON.stringify(put.input.Item)).not.toContain(code);
    expect(sent(send, DeleteCommand)[0].input).toMatchObject({ Key: { pk: "OAUTHREQ#r1" }, ExpressionAttributeNames: { "#ttl": "ttl" } });
  });

  it("deny sends access_denied and makes no code", async () => {
    const send = fakeTable({ items: { "OAUTHREQ#r1": request } });
    const url = new URL((await oauthRepo().decide(user, "r1", "deny")).redirectTo);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("code")).toBeNull();
    expect(sent(send, PutCommand)).toEqual([]);
  });

  it("a used or expired request is not found, with the consent page's expired copy", async () => {
    fakeTable({ deleteFails: true });
    const refused = oauthRepo().decide(user, "r1", "allow");
    await expect(refused).rejects.toBeInstanceOf(NotFound);
    await expect(refused).rejects.toThrow("This sign-in request expired. Start again from your app.");
  });
});

describe("code exchange", () => {
  const verifier = "v".repeat(43);
  const code = `cl_code_${"c".repeat(43)}`;
  const items = {
    [`OAUTHCODE#${hashOf(code)}`]: {
      clientId: "c1", redirectUri: "https://x.com/cb", codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      scopes: ["rooms:read"], userId: "u1", username: "aman", ttl: nowSec() + 60,
    },
    "OAUTHCLIENT#c1": { clientId: "c1", clientName: "App", ttl: nowSec() + 999 },
  };
  const form = new URLSearchParams({ grant_type: "authorization_code", code, client_id: "c1", redirect_uri: "https://x.com/cb", code_verifier: verifier });

  it("signing in again from the same app replaces its older grant, so Connected apps lists it once", async () => {
    const send = fakeTable({ items, grants: [{ grantId: "old", clientId: "c1" }] });
    await oauthRepo().token(form);
    const [query] = sent(send, QueryCommand);
    expect(query.input).toMatchObject({
      IndexName: "gsi1", FilterExpression: "clientId = :c", ExpressionAttributeValues: { ":u": "MCPAPPS#u1", ":c": "c1" },
    });
    expect(sent(send, DeleteCommand).map((d) => d.input.Key)).toEqual([{ pk: "OAUTHGRANT#old", sk: "META" }]);
  });
});

describe("refresh", () => {
  const grant = (refreshHash: string, over: object = {}) => ({
    grantId, clientId: "c1", userId: "u1", username: "aman", scopes: ["rooms:read"], refreshHash, accessHash: "x", accessExp: nowSec() + 60,
    ttl: nowSec() + 999, ...over,
  });
  const form = (token: string) => new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: "c1" });
  const token = `cl_rt_${grantId}_${"a".repeat(43)}`;
  const newer = hashOf(`cl_rt_${grantId}_${"b".repeat(43)}`);
  const client = { "OAUTHCLIENT#c1": { clientId: "c1", ttl: nowSec() + 999 } };
  const active = async () => true;

  it("the token just rotated, presented again within 30 s, is refused without revoking: one client refreshing twice at once", async () => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant(newer, { prevRefreshHash: hashOf(token), rotatedAt: nowSec() - 5 }) } });
    await expect(oauthRepo(active).token(form(token))).rejects.toMatchObject({ code: "invalid_grant" });
    expect(sent(send, DeleteCommand)).toEqual([]);
  });

  it("the token just rotated, presented again later, revokes the grant", async () => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant(newer, { prevRefreshHash: hashOf(token), rotatedAt: nowSec() - 60 }) } });
    await expect(oauthRepo(active).token(form(token))).rejects.toMatchObject({ code: "invalid_grant" });
    expect(sent(send, DeleteCommand)).toHaveLength(1);
  });

  it.each(["ConditionalCheckFailed", "TransactionConflict"])("losing the rotation to a concurrent refresh (%s) keeps the grant", async (code) => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant(hashOf(token)), ...client }, transactFails: code });
    await expect(oauthRepo(active).token(form(token))).rejects.toMatchObject({ code: "invalid_grant" });
    expect(sent(send, DeleteCommand)).toEqual([]);
  });

  it("an account deleted or disabled since sign-in revokes the grant at its next refresh", async () => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant(hashOf(token)), ...client } });
    const asked: string[] = [];
    await expect(oauthRepo(async (username) => (asked.push(username), false)).token(form(token))).rejects.toMatchObject({ code: "invalid_grant" });
    expect(asked).toEqual(["aman"]);
    expect(sent(send, DeleteCommand)[0]!.input.Key).toEqual({ pk: `OAUTHGRANT#${grantId}`, sk: "META" });
    expect(sent(send, TransactWriteCommand)).toEqual([]);
  });

  it("a refresh token that isn't the current one revokes the whole grant", async () => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant(hashOf(`cl_rt_${grantId}_${"b".repeat(43)}`)) } });
    await expect(oauthRepo().token(form(token))).rejects.toMatchObject({ code: "invalid_grant" });
    expect(sent(send, DeleteCommand)[0].input.Key).toEqual({ pk: `OAUTHGRANT#${grantId}`, sk: "META" });
  });

  it("an access token sent as a refresh token is refused without revoking anything", async () => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant(hashOf(token)) } });
    await expect(oauthRepo().token(form(`cl_at_${grantId}_${"a".repeat(43)}`))).rejects.toMatchObject({ code: "invalid_grant" });
    expect(sent(send, DeleteCommand)).toEqual([]);
  });

  it("rotates on the current hash only, so a concurrent rotation loses", async () => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant(hashOf(token)), ...client } });
    const res = await oauthRepo(active).token(form(token)) as Record<string, unknown>;
    expect(res).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "rooms:read" });
    expect(res.refresh_token).not.toBe(token);
    const json = JSON.stringify(send.mock.calls.map(([c]) => (c as { input: unknown }).input));
    expect(json).toContain(`"ConditionExpression":"refreshHash = :old"`);
    expect(json).toContain("prevRefreshHash = :old, rotatedAt = :now");
    expect(json).not.toContain(String(res.access_token));
    expect(json).not.toContain(String(res.refresh_token));
  });
});

describe("verifyAccess", () => {
  const token = `cl_at_${grantId}_${"a".repeat(43)}`;
  const grant = (over: object) => ({
    grantId, userId: "u1", username: "aman", scopes: ["rooms:read"], accessHash: hashOf(token), accessExp: nowSec() + 60,
    lastUsedAt: new Date().toISOString(), ttl: nowSec() + 999, ...over,
  });

  it("returns the user and scopes, and skips the lastUsedAt write within a minute", async () => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant({}) } });
    expect(await oauthRepo().verifyAccess(token)).toEqual({ user: { userId: "u1", username: "aman" }, scopes: ["rooms:read"], grantId });
    expect(sent(send, UpdateCommand)).toEqual([]);
  });

  it("bumps lastUsedAt once a minute has passed", async () => {
    const send = fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant({ lastUsedAt: "2026-01-01T00:00:00.000Z" }) } });
    await oauthRepo().verifyAccess(token);
    expect(sent(send, UpdateCommand)[0].input).toMatchObject({ Key: { pk: `OAUTHGRANT#${grantId}` }, ConditionExpression: "attribute_exists(pk)" });
  });

  it("an expired, unknown or wrong token is null", async () => {
    fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant({ accessExp: nowSec() - 1 }) } });
    expect(await oauthRepo().verifyAccess(token)).toBeNull();
    vi.restoreAllMocks();
    fakeTable({ items: { [`OAUTHGRANT#${grantId}`]: grant({}) } });
    expect(await oauthRepo().verifyAccess(`cl_at_${grantId}_${"b".repeat(43)}`)).toBeNull();
    expect(await oauthRepo().verifyAccess("garbage")).toBeNull();
  });
});

describe("revoke", () => {
  it("deletes the grant only if the token is one of its own, and a stranger's token still succeeds", async () => {
    const send = fakeTable({ deleteFails: true });
    const token = `cl_rt_${grantId}_${"a".repeat(43)}`;
    await expect(oauthRepo().revoke(new URLSearchParams({ token }))).resolves.toBeUndefined();
    expect(sent(send, DeleteCommand)[0].input).toMatchObject({ ExpressionAttributeValues: { ":h": hashOf(token) } });
    await expect(oauthRepo().revoke(new URLSearchParams({ token: "nope" }))).resolves.toBeUndefined();
  });
});

describe("revokeApp", () => {
  it("someone else's grant is a 404", async () => {
    fakeTable({ deleteFails: true });
    await expect(oauthRepo().revokeApp("u2", grantId)).rejects.toThrow("No such app.");
  });
});
