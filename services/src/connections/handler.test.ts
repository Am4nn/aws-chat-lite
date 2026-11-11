import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { fakeGitHubFetch, fakeKeys, fakeSignInPage } from "../tools/fake-github.js";
import type { Role } from "../rooms/access.js";
import { makeHandler } from "./handler.js";
import { connectionsRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1", SITE_ORIGINS: "http://localhost:3000" });

afterEach(() => vi.restoreAllMocks());

const REDIRECT = "http://localhost:3000/bff/github/callback";
const connection = { installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "aman", addedAt: "2026-11-11T10:00:00.000Z" };
const keyOf = (k: Record<string, unknown> | undefined) => `${k?.pk}|${k?.sk}`;
const nowSec = () => Math.floor(Date.now() / 1000);
/** What u1 may connect in room r after signing in with GitHub. */
const grant = (ttl = nowSec() + 60) => ({
  pk: "GHGRANT#r#u1", sk: "META", installations: [{ id: 1, account: "fake-org", repos: ["fake-org/playground"] }], ttl,
});
const noGrants = [[], [grant(nowSec() - 1)], [{ ...grant(), pk: "GHGRANT#r#u2" }], [{ ...grant(), pk: "GHGRANT#other#u1" }]];

type Rows = { github?: object; approvalTimeoutSec?: number; mcp?: object[]; items?: Record<string, unknown>[] };

/**
 * The table as members with these roles see it. Puts and deletes are kept, so a flow written by one request is there
 * for the next; conditions aren't evaluated, except that a conditional delete needs its item.
 */
function fakeTable(roles: Record<string, Role>, rows: Rows = {}) {
  const items = new Map((rows.items ?? []).map((r) => [keyOf(r), r]));
  const send = vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const { pk, sk } = c.input.Key as { pk: string; sk: string };
      if (sk.startsWith("MEMBER#")) {
        const role = roles[sk.slice("MEMBER#".length)];
        return { Item: role && { role } };
      }
      if (pk.startsWith("ROOM#") && sk === "META") {
        return { Item: { name: "Room", ...(rows.approvalTimeoutSec && { approvalTimeoutSec: rows.approvalTimeoutSec }) } };
      }
      if (sk === "CONN#github") return { Item: rows.github };
      return { Item: items.get(keyOf(c.input.Key)) };
    }
    if (c instanceof QueryCommand) {
      const v = c.input.ExpressionAttributeValues!;
      return { Items: v[":prefix"] === "CONN#mcp#" ? (rows.mcp ?? []).map((m) => ({ pk: v[":pk"], sk: `CONN#mcp#${(m as { name: string }).name}`, ...m })) : [] };
    }
    if (c instanceof PutCommand) items.set(keyOf(c.input.Item), c.input.Item!);
    if (c instanceof DeleteCommand) {
      const old = items.get(keyOf(c.input.Key));
      if (!old && c.input.ConditionExpression) throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
      items.delete(keyOf(c.input.Key));
      return { Attributes: old };
    }
    return {};
  }) as never);
  return { send, items };
}

const ev = (routeKey: string, body?: unknown, sub = "u1") => ({
  routeKey,
  body: body === undefined ? undefined : JSON.stringify(body),
  pathParameters: { roomId: "r" },
  requestContext: { authorizer: { jwt: { claims: { sub, "cognito:username": sub === "u1" ? "aman" : "bea" } } } },
}) as any;

function handler(keys = fakeKeys()) {
  const notify = vi.fn(async (_roomId: string) => {});
  const fetch = vi.fn(fakeGitHubFetch);
  return { notify, fetch, handle: makeHandler(connectionsRepo(), async () => ({ fetch, keys }), notify, fakeSignInPage) };
}

const call = async (role: Role, routeKey: string, body?: unknown, rows?: Rows) => {
  const { send, items } = fakeTable({ u1: role }, rows);
  const { notify, fetch, handle } = handler();
  const res = await handle(ev(routeKey, body));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body as string) : undefined, notify, send, items, fetch };
};

const writes = (send: ReturnType<typeof fakeTable>["send"]) =>
  send.mock.calls.map(([c]) => c).filter((c) => c instanceof TransactWriteCommand) as TransactWriteCommand[];

describe("approval timeout", () => {
  it("takes whole minutes from 5 to 1440", async () => {
    expect((await call("owner", "PUT /rooms/{roomId}/approval-timeout", { minutes: 3 })).status).toBe(400);
    expect((await call("owner", "PUT /rooms/{roomId}/approval-timeout", { minutes: 2.5 })).status).toBe(400);
  });

  it("a member can't change it", async () => {
    const res = await call("member", "PUT /rooms/{roomId}/approval-timeout", { minutes: 30 });
    expect(res.status).toBe(403);
    expect(res.notify).not.toHaveBeenCalled();
  });

  it("an admin sets it in seconds on the room, logs it, and the room hears", async () => {
    const res = await call("admin", "PUT /rooms/{roomId}/approval-timeout", { minutes: 30 });
    expect(res).toMatchObject({ status: 200, body: { approvalTimeoutMin: 30 } });
    expect(res.notify).toHaveBeenCalledWith("r");
    const [meta, audit] = writes(res.send)[0]!.input.TransactItems!;
    expect(meta!.Update).toMatchObject({ Key: { pk: "ROOM#r", sk: "META" }, ExpressionAttributeValues: { ":sec": 1800 } });
    expect(audit!.Put?.Item).toMatchObject({ pk: "ROOM#r", kind: "timeout", actor: "aman", detail: "30 min" });
  });
});

describe("signing in with GitHub", () => {
  const signIn = "POST /rooms/{roomId}/connections/github/sign-in";
  const finish = "POST /github-flows/finish";

  /** Starts a sign-in as u1 and follows the fake sign-in page back to the return address. */
  async function signedIn(roles: Record<string, Role> = { u1: "admin" }) {
    const table = fakeTable(roles);
    const h = handler();
    const res = await h.handle(ev(signIn, { redirectUri: REDIRECT }));
    const back = new URL(JSON.parse(String(res.body)).authorizeUrl);
    const answer = async (body: object, sub = "u1") => {
      const r = await h.handle(ev(finish, body, sub));
      return { status: r.statusCode, body: JSON.parse(String(r.body)) };
    };
    return { ...table, ...h, res, back, state: back.searchParams.get("state")!, code: back.searchParams.get("code")!, answer };
  }

  it("a member can't start one, and the return address must be the site's own", async () => {
    expect((await call("member", signIn, { redirectUri: REDIRECT })).status).toBe(403);
    for (const redirectUri of ["https://evil.example/bff/github/callback", "http://localhost:3000/bff/mcp/callback", undefined]) {
      expect((await call("admin", signIn, { redirectUri })).status).toBe(400);
    }
  });

  it("an admin is sent to GitHub's sign-in, with a ten-minute flow bound to them and the room", async () => {
    const t = await signedIn();
    expect(t.res.statusCode).toBe(200);
    expect(t.back.origin + t.back.pathname).toBe(REDIRECT);
    expect(t.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const flow = t.items.get(`GHFLOW#${t.state}|META`)!;
    expect(flow).toMatchObject({ roomId: "r", userId: "u1", redirectUri: REDIRECT });
    expect(Number(flow.ttl) - nowSec()).toBeGreaterThan(590);
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("finishing keeps what that admin's GitHub account can reach for 15 minutes, and never the user token", async () => {
    const t = await signedIn();
    expect(await t.answer({ state: t.state, code: t.code })).toEqual({ status: 200, body: { roomId: "r" } });
    const kept = t.items.get("GHGRANT#r#u1|META")!;
    expect(kept.installations).toEqual([{ id: 1, account: "fake-org", repos: ["fake-org/playground"] }]);
    expect(Number(kept.ttl) - nowSec()).toBeGreaterThan(890);
    expect(t.items.has(`GHFLOW#${t.state}|META`)).toBe(false);
    expect(JSON.stringify([...t.items.values()])).not.toMatch(/ghu_|fake-client-secret/);
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("a state works once, and a malformed one is the expired copy", async () => {
    const t = await signedIn();
    await t.answer({ state: t.state, code: t.code });
    expect(await t.answer({ state: t.state, code: t.code })).toEqual({ status: 410, body: { error: "This GitHub sign-in expired. Try again." } });
    for (const state of [undefined, "", "a/b", "x".repeat(101)]) expect((await t.answer({ state, code: t.code })).status).toBe(410);
  });

  it("only the admin who started it may finish it, and someone else's try neither uses it up nor leaves the room", async () => {
    const t = await signedIn({ u1: "admin", u2: "admin" });
    expect(await t.answer({ state: t.state, code: t.code }, "u2")).toEqual({
      status: 403, body: { error: "Finish signing in as the admin who started it.", roomId: "r" },
    });
    expect([...t.items.keys()].some((k) => k.startsWith("GHGRANT#"))).toBe(false);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.send.mock.calls.some(([c]) => c instanceof DeleteCommand)).toBe(false);
    expect(await t.answer({ state: t.state, code: t.code })).toEqual({ status: 200, body: { roomId: "r" } });
  });

  it("a refusal on GitHub's page, or a code GitHub won't take, is a line for the admin", async () => {
    let t = await signedIn();
    expect(await t.answer({ state: t.state, error: "access_denied" })).toEqual({
      status: 502, body: { error: "GitHub didn't allow access (access_denied).", roomId: "r" },
    });
    t = await signedIn();
    expect(await t.answer({ state: t.state, code: "fake-code.wrong" })).toEqual({
      status: 502, body: { error: "GitHub refused the sign-in (bad_verification_code).", roomId: "r" },
    });
  });

  it("an admin demoted since starting gets nothing", async () => {
    const t = await signedIn();
    t.send.mockRestore();
    const after = fakeTable({ u1: "member" }, { items: [...t.items.values()] });
    expect((await t.answer({ state: t.state, code: t.code })).status).toBe(403);
    expect(after.items.has("GHGRANT#r#u1|META")).toBe(false);
  });

  it("has no sign-in without the App's client id", async () => {
    fakeTable({ u1: "owner" });
    const { githubClientId: _, ...keys } = fakeKeys();
    const res = await handler(keys).handle(ev(signIn, { redirectUri: REDIRECT }));
    expect(res.statusCode).toBe(409);
  });
});

describe("GitHub connection", () => {
  const put = "PUT /rooms/{roomId}/connections/github";
  const list = "GET /rooms/{roomId}/connections/github/installations";
  const pick = { installationId: 1, repos: ["fake-org/playground"] };

  it("an admin lists what their own fresh GitHub sign-in in this room can reach, without calling GitHub", async () => {
    const res = await call("admin", list, undefined, { items: [grant()] });
    expect(res.body).toEqual({ installations: [{ id: 1, account: "fake-org", repos: ["fake-org/playground"] }] });
    expect(res.fetch).not.toHaveBeenCalled();
    for (const items of noGrants) {
      expect(await call("admin", list, undefined, { items })).toMatchObject({ status: 410, body: { error: "Sign in with GitHub to pick repos." } });
    }
  });

  it("refuses repos outside the chosen installation", async () => {
    const res = await call("owner", put, { installationId: 1, repos: ["fake-org/other"] }, { items: [grant()] });
    expect(res).toMatchObject({ status: 400, body: { error: "Pick repos from that installation." } });
    expect(writes(res.send)).toEqual([]);
  });

  it("refuses an installation the admin's GitHub account can't reach, and an empty pick", async () => {
    expect((await call("owner", put, { ...pick, installationId: 2 }, { items: [grant()] })).status).toBe(400);
    expect((await call("owner", put, { ...pick, repos: [] }, { items: [grant()] })).status).toBe(400);
  });

  it("refuses any pick without a fresh sign-in by this admin in this room", async () => {
    for (const items of noGrants) {
      const res = await call("admin", put, pick, { items });
      expect(res.status).toBe(410);
      expect(writes(res.send)).toEqual([]);
    }
  });

  it("an admin connects repos of the installation; the change is logged and the room hears", async () => {
    const res = await call("admin", put, pick, { items: [grant()] });
    expect(res.status).toBe(200);
    expect(res.body.github).toMatchObject({ installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "aman" });
    const [conn, audit] = writes(res.send)[0]!.input.TransactItems!;
    expect(conn!.Put?.Item).toMatchObject({ pk: "ROOM#r", sk: "CONN#github", installationId: 1 });
    expect(audit!.Put?.Item).toMatchObject({ kind: "connected", actor: "aman", detail: "fake-org/playground" });
    expect(res.notify).toHaveBeenCalledWith("r");
    expect(res.fetch).not.toHaveBeenCalled();
  });

  it("a member can't connect, list installations or disconnect, even holding a sign-in", async () => {
    expect((await call("member", put, pick, { items: [grant()] })).status).toBe(403);
    expect((await call("member", list, undefined, { items: [grant()] })).status).toBe(403);
    expect((await call("member", "DELETE /rooms/{roomId}/connections/github")).status).toBe(403);
  });

  it("disconnecting is a 204, logged, and the room hears", async () => {
    const res = await call("owner", "DELETE /rooms/{roomId}/connections/github", undefined, { github: connection });
    expect(res.status).toBe(204);
    const [conn, audit] = writes(res.send)[0]!.input.TransactItems!;
    expect(conn!.Delete).toMatchObject({ Key: { pk: "ROOM#r", sk: "CONN#github" }, ConditionExpression: "attribute_exists(sk)" });
    expect(audit!.Put?.Item).toMatchObject({ kind: "disconnected", actor: "aman" });
    expect(res.notify).toHaveBeenCalledWith("r");
  });
});

describe("GET connections", () => {
  it("a member reads the connection and the timeout but can't manage, and no key material leaves", async () => {
    const res = await call("member", "GET /rooms/{roomId}/connections", undefined, { github: connection, approvalTimeoutSec: 2700 });
    expect(res.body).toEqual({
      github: connection, mcp: [], approvalTimeoutMin: 45, canManage: false, installUrl: "https://github.com/apps/fake-app/installations/new",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/BEGIN|ghs_|tvly-/);
    expect(JSON.stringify(res.body)).not.toContain("fake-client");
  });

  it("defaults to 2 hours and no connection; an admin can manage", async () => {
    const res = await call("admin", "GET /rooms/{roomId}/connections");
    expect(res.body).toMatchObject({ github: null, approvalTimeoutMin: 120, canManage: true });
  });

  it("lists the room's MCP servers, read consistently, without their table keys", async () => {
    const mcp = { name: "test", url: "https://x.example/mcp", auth: "oauth", status: "needs_auth", tools: [], toolCount: 0, toolsAt: "t", addedBy: "aman", addedAt: "t" };
    const res = await call("member", "GET /rooms/{roomId}/connections", undefined, { mcp: [mcp] });
    expect(res.body.mcp).toEqual([mcp]);
    const query = res.send.mock.calls.map(([c]) => c).find((c) => c instanceof QueryCommand) as QueryCommand;
    expect(query.input).toMatchObject({ ConsistentRead: true, ExpressionAttributeValues: { ":pk": "ROOM#r", ":prefix": "CONN#mcp#" } });
  });

  it("has no install link without App keys", async () => {
    fakeTable({ u1: "owner" });
    const res = await handler({}).handle(ev("GET /rooms/{roomId}/connections"));
    expect(JSON.parse(res.body as string).installUrl).toBeNull();
  });
});

describe("audit log", () => {
  it("any member reads it, a page at a time", async () => {
    const res = await call("member", "GET /rooms/{roomId}/audit");
    expect(res).toMatchObject({ status: 200, body: { entries: [] } });
    const query = res.send.mock.calls.map(([c]) => c).find((c) => c instanceof QueryCommand) as QueryCommand;
    expect(query.input.ExpressionAttributeValues).toMatchObject({ ":pk": "ROOM#r" });
  });
});
