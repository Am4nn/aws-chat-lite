import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { fakeGitHubFetch, fakeKeys } from "../tools/fake-github.js";
import type { Role } from "../rooms/access.js";
import { makeHandler } from "./handler.js";
import { connectionsRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const connection = { installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "aman", addedAt: "2026-11-11T10:00:00.000Z" };

/** The table as the caller with `role` sees it; writes succeed and are recorded. */
function fakeTable(role: Role, rows: { github?: object; approvalTimeoutSec?: number } = {}) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const sk = String(c.input.Key?.sk);
      if (sk.startsWith("MEMBER#")) return { Item: { role } };
      if (sk === "META") return { Item: { name: "Room", ...(rows.approvalTimeoutSec && { approvalTimeoutSec: rows.approvalTimeoutSec }) } };
      if (sk === "CONN#github") return { Item: rows.github };
    }
    if (c instanceof QueryCommand) return { Items: [] };
    return {};
  }) as never);
}

const ev = (routeKey: string, body?: unknown) => ({
  routeKey,
  body: body === undefined ? undefined : JSON.stringify(body),
  pathParameters: { roomId: "r" },
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

function handler(keys = fakeKeys()) {
  const notify = vi.fn(async (_roomId: string) => {});
  return { notify, handle: makeHandler(connectionsRepo(), async () => ({ fetch: fakeGitHubFetch, keys }), notify) };
}

const call = async (role: Role, routeKey: string, body?: unknown, rows?: Parameters<typeof fakeTable>[1]) => {
  const send = fakeTable(role, rows);
  const { notify, handle } = handler();
  const res = await handle(ev(routeKey, body));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body as string) : undefined, notify, send };
};

const writes = (send: ReturnType<typeof fakeTable>) =>
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
    const [meta, audit] = writes(res.send)[0].input.TransactItems!;
    expect(meta.Update).toMatchObject({ Key: { pk: "ROOM#r", sk: "META" }, ExpressionAttributeValues: { ":sec": 1800 } });
    expect(audit.Put?.Item).toMatchObject({ pk: "ROOM#r", kind: "timeout", actor: "aman", detail: "30 min" });
  });
});

describe("GitHub connection", () => {
  it("refuses repos outside the chosen installation", async () => {
    const res = await call("owner", "PUT /rooms/{roomId}/connections/github", { installationId: 1, repos: ["fake-org/other"] });
    expect(res).toMatchObject({ status: 400, body: { error: "Pick repos from that installation." } });
    expect(writes(res.send)).toEqual([]);
  });

  it("refuses an installation the App doesn't have, and an empty pick", async () => {
    expect((await call("owner", "PUT /rooms/{roomId}/connections/github", { installationId: 2, repos: ["fake-org/playground"] })).status).toBe(400);
    expect((await call("owner", "PUT /rooms/{roomId}/connections/github", { installationId: 1, repos: [] })).status).toBe(400);
  });

  it("an admin connects repos of the installation; the change is logged and the room hears", async () => {
    const res = await call("admin", "PUT /rooms/{roomId}/connections/github", { installationId: 1, repos: ["fake-org/playground"] });
    expect(res.status).toBe(200);
    expect(res.body.github).toMatchObject({ installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "aman" });
    const [conn, audit] = writes(res.send)[0].input.TransactItems!;
    expect(conn.Put?.Item).toMatchObject({ pk: "ROOM#r", sk: "CONN#github", installationId: 1 });
    expect(audit.Put?.Item).toMatchObject({ kind: "connected", actor: "aman", detail: "fake-org/playground" });
    expect(res.notify).toHaveBeenCalledWith("r");
  });

  it("a member can't connect, list installations or disconnect", async () => {
    expect((await call("member", "PUT /rooms/{roomId}/connections/github", { installationId: 1, repos: ["fake-org/playground"] })).status).toBe(403);
    expect((await call("member", "GET /rooms/{roomId}/connections/github/installations")).status).toBe(403);
    expect((await call("member", "DELETE /rooms/{roomId}/connections/github")).status).toBe(403);
  });

  it("an admin lists the App's installations and their repos", async () => {
    const res = await call("admin", "GET /rooms/{roomId}/connections/github/installations");
    expect(res.body).toEqual({ installations: [{ id: 1, account: "fake-org", repos: ["fake-org/playground"] }] });
  });

  it("disconnecting is a 204, logged, and the room hears", async () => {
    const res = await call("owner", "DELETE /rooms/{roomId}/connections/github", undefined, { github: connection });
    expect(res.status).toBe(204);
    const [conn, audit] = writes(res.send)[0].input.TransactItems!;
    expect(conn.Delete).toMatchObject({ Key: { pk: "ROOM#r", sk: "CONN#github" }, ConditionExpression: "attribute_exists(sk)" });
    expect(audit.Put?.Item).toMatchObject({ kind: "disconnected", actor: "aman" });
    expect(res.notify).toHaveBeenCalledWith("r");
  });
});

describe("GET connections", () => {
  it("a member reads the connection and the timeout but can't manage, and no key material leaves", async () => {
    const res = await call("member", "GET /rooms/{roomId}/connections", undefined, { github: connection, approvalTimeoutSec: 2700 });
    expect(res.body).toEqual({
      github: connection, approvalTimeoutMin: 45, canManage: false, installUrl: "https://github.com/apps/fake-app/installations/new",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/BEGIN|ghs_|tvly-/);
  });

  it("defaults to 2 hours and no connection; an admin can manage", async () => {
    const res = await call("admin", "GET /rooms/{roomId}/connections");
    expect(res.body).toMatchObject({ github: null, approvalTimeoutMin: 120, canManage: true });
  });

  it("has no install link without App keys", async () => {
    fakeTable("owner");
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
