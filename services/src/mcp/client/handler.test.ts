import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/db.js";
import type { Role } from "../../rooms/access.js";
import { startMcpTestServer } from "../testing/server.js";
import { guardedFetch } from "./fetch.js";
import { makeHandler } from "./handler.js";
import { mcpRepo } from "./repo.js";
import { unseal } from "./seal.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1", SITE_ORIGINS: "http://localhost:3000,http://localhost:3100" });

const REDIRECT = "http://localhost:3000/bff/mcp/callback";
const HOSTS = ["127.0.0.1"];
const KEY = Buffer.alloc(32, 7);
const SECRET_WORDS = /access_token|refresh_token|code_verifier|client_secret/;

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(o?: Parameters<typeof startMcpTestServer>[0]) {
  const server = await startMcpTestServer(o);
  servers.push(server);
  return server;
}

const keyOf = (k: Record<string, unknown> | undefined) => `${k?.pk}|${k?.sk}`;

/**
 * The table as members with these roles see it. Puts and deletes are kept, so a flow written by one request is there
 * for the next; conditions aren't evaluated (the integration tests run them on DynamoDB).
 */
function fakeTable(roles: Record<string, Role>, rows: Record<string, unknown>[] = []) {
  const items = new Map(rows.map((r) => [keyOf(r), r]));
  const send = vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const sk = String(c.input.Key?.sk);
      if (sk.startsWith("MEMBER#")) {
        const role = roles[sk.slice("MEMBER#".length)];
        return { Item: role && { role } };
      }
      return { Item: items.get(keyOf(c.input.Key)) };
    }
    if (c instanceof QueryCommand) {
      const v = c.input.ExpressionAttributeValues!;
      return { Items: [...items.values()].filter((i) => i.pk === v[":pk"] && String(i.sk).startsWith(String(v[":prefix"]))) };
    }
    if (c instanceof PutCommand) items.set(keyOf(c.input.Item), c.input.Item!);
    if (c instanceof DeleteCommand) {
      const old = items.get(keyOf(c.input.Key));
      if (!old && c.input.ConditionExpression) throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
      items.delete(keyOf(c.input.Key));
      return { Attributes: old };
    }
    if (c instanceof TransactWriteCommand) {
      for (const t of c.input.TransactItems!) {
        if (t.Put) items.set(keyOf(t.Put.Item), t.Put.Item!);
        if (t.Delete) items.delete(keyOf(t.Delete.Key));
      }
    }
    if (c instanceof UpdateCommand) return { Attributes: items.get(keyOf(c.input.Key)) };
    return {};
  }) as never);
  const commands = <T>(type: new (...args: never[]) => T) => send.mock.calls.map(([c]) => c).filter((c) => c instanceof type) as T[];
  return { items, commands };
}

const ev = (routeKey: string, body?: unknown, { sub = "u1", name = "test" } = {}) => ({
  routeKey,
  body: body === undefined ? undefined : JSON.stringify(body),
  pathParameters: { roomId: "r", name },
  requestContext: { authorizer: { jwt: { claims: { sub, "cognito:username": sub === "u1" ? "aman" : "bea" } } } },
}) as any;

function setup(roles: Record<string, Role> = { u1: "admin" }, rows?: Record<string, unknown>[]) {
  const table = fakeTable(roles, rows);
  const fetch = vi.fn(guardedFetch({ localHosts: HOSTS }));
  const notify = vi.fn(async (_roomId: string) => {});
  const handle = makeHandler(mcpRepo({ fetch, hosts: HOSTS, key: async () => KEY, notifyRoom: notify }), notify);
  const bodies: string[] = [];
  const call = async (...args: Parameters<typeof ev>) => {
    const res = await handle(ev(...args));
    bodies.push(String(res.body ?? ""));
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body as string) : undefined };
  };
  return { ...table, fetch, notify, call, bodies };
}

const connect = (body: Record<string, unknown>) => ["POST /rooms/{roomId}/connections/mcp", { name: "test", redirectUri: REDIRECT, ...body }] as const;
const mcpRow = (name: string) => ({ pk: "ROOM#r", sk: `CONN#mcp#${name}`, name, url: "https://x.example/mcp", auth: "none", status: "connected" });

describe("who may change a room's MCP servers", () => {
  it("a member gets 403 on every change, and nothing is written or sent", async () => {
    const t = setup({ u1: "member" }, [mcpRow("test")]);
    for (const [route, body] of [
      connect({ url: "https://x.example/mcp" }),
      ["POST /rooms/{roomId}/connections/mcp/{name}/reconnect", { redirectUri: REDIRECT }],
      ["POST /rooms/{roomId}/connections/mcp/{name}/refresh", undefined],
      ["DELETE /rooms/{roomId}/connections/mcp/{name}", undefined],
    ] as const) {
      expect((await t.call(route, body)).status, route).toBe(403);
    }
    expect(t.commands(TransactWriteCommand)).toEqual([]);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.notify).not.toHaveBeenCalled();
  });
});

describe("adding a server", () => {
  it("refuses a bad name before reaching the server", async () => {
    const t = setup();
    for (const name of ["", "Test", "-x", "a".repeat(21), "a_b", 7]) {
      expect(await t.call(...connect({ name, url: "https://x.example/mcp" }))).toEqual({
        status: 400, body: { error: "Name it with 1–20 lowercase letters, digits or dashes." },
      });
    }
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("returns only to chat-lite's own callback", async () => {
    const t = setup();
    for (const redirectUri of ["https://evil.example/bff/mcp/callback", "http://localhost:3000/elsewhere", undefined]) {
      expect((await t.call(...connect({ url: "https://x.example/mcp", redirectUri }))).status).toBe(400);
    }
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("refuses an http URL off this machine and keys in the URL", async () => {
    const t = setup();
    expect((await t.call(...connect({ url: "http://x.example/mcp" }))).body).toEqual({ error: "Use an https URL." });
    expect((await t.call(...connect({ url: "https://x.example/mcp?api_key=1" }))).body).toEqual({
      error: "Don't put keys in the URL: chat-lite signs in with OAuth.",
    });
  });

  it("a taken name and a sixth server are refused", async () => {
    const t = setup({ u1: "admin" }, [mcpRow("test")]);
    expect(await t.call(...connect({ url: "https://x.example/mcp" }))).toEqual({
      status: 409, body: { error: "This room already has an MCP server called test." },
    });
    const full = setup({ u1: "admin" }, ["a", "b", "c", "d", "e"].map(mcpRow));
    expect(await full.call(...connect({ url: "https://x.example/mcp" }))).toEqual({
      status: 409, body: { error: "A room can connect up to 5 MCP servers." },
    });
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("a server without sign-in is connected at once, with its tools, logged, and the room hears", async () => {
    const server = await start({ auth: "none" });
    const t = setup();
    const res = await t.call(...connect({ url: server.url }));
    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ name: "test", url: server.url, auth: "none", status: "connected", toolCount: 4, addedBy: "aman" });
    expect(res.body.connection.tools.map((x: { name: string; readOnly: boolean }) => [x.name, x.readOnly])).toEqual([
      ["echo", true], ["add_note", false], ["whoami", true], ["fail", true],
    ]);
    const [write] = t.commands(TransactWriteCommand);
    const [conn, audit] = write!.input.TransactItems!;
    expect(conn!.Put?.Item).toMatchObject({ pk: "ROOM#r", sk: "CONN#mcp#test", status: "connected" });
    // Room subscriptions share the CONN# prefix and are matched by userId, so a connection must never carry one.
    expect(conn!.Put?.Item).not.toHaveProperty("userId");
    expect(audit!.Put?.Item).toMatchObject({ kind: "connected", actor: "aman", detail: "MCP test (127.0.0.1)" });
    expect(write!.input.TransactItems).toHaveLength(2);
    expect(t.notify).toHaveBeenCalledWith("r");
  });

  it("a server with sign-in gets an authorize URL, and the flow keeps its verifier sealed", async () => {
    const server = await start();
    const t = setup();
    const res = await t.call(...connect({ url: server.url }));
    expect(res.status).toBe(200);
    const authorize = new URL(res.body.authorizeUrl);
    expect(authorize.origin).toBe(server.origin);
    const state = authorize.searchParams.get("state")!;
    const flow = t.items.get(`MCPFLOW#${state}|META`)!;
    expect(flow).toMatchObject({ roomId: "r", userId: "u1", name: "test", url: server.url, reconnect: false });
    expect(Number(flow.ttl) - Date.now() / 1000).toBeGreaterThan(590);
    const pending = JSON.parse(unseal(KEY, String(flow.pending), state));
    expect(JSON.stringify(flow)).not.toContain(pending.codeVerifier);
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.commands(TransactWriteCommand)).toEqual([]);
  });
});

describe("remote servers that fail", () => {
  it("each failure is a line for the admin, never a 500", async () => {
    const closed = await start();
    const url = closed.url;
    await closed.close();
    const noSignUp = await start({ registration: false });
    const badMetadata = await start({ metadataOverrides: { authorization_endpoint: "javascript:alert(1)" } });
    const t = setup();
    const answers = [];
    for (const server of [url, noSignUp.url, badMetadata.url]) answers.push(await t.call(...connect({ url: server })));
    expect(answers.map((a) => a.status)).toEqual([502, 502, 502]);
    expect(answers[0]!.body.error).toMatch(/^127\.0\.0\.1 didn't answer: .*ECONNREFUSED/);
    expect(answers[1]!.body.error).toBe("127.0.0.1 doesn't let new apps sign up, so chat-lite can't connect to it.");
    expect(answers[2]!.body.error).toBe("127.0.0.1 sent an answer chat-lite can't read.");
  });
});

describe("finishing a sign-in", () => {
  /** Starts a flow as u1 and walks the browser through the test server's authorize page. */
  async function begun(o?: Parameters<typeof startMcpTestServer>[0]) {
    const server = await start(o);
    const t = setup({ u1: "admin", u2: "admin" });
    const { body } = await t.call(...connect({ url: server.url }));
    const back = new URL((await t.fetch(body.authorizeUrl)).headers.get("location")!);
    const q = back.searchParams;
    return { server, t, state: q.get("state"), code: q.get("code") ?? undefined, error: q.get("error") ?? undefined };
  }
  const finish = "POST /mcp-flows/finish";

  it("the admin who started it connects the server; tokens are stored sealed to the room, and no body carries one", async () => {
    const { t, state, code } = await begun();
    const res = await t.call(finish, { state, code });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roomId: "r", connection: { name: "test", auth: "oauth", status: "connected", toolCount: 4 } });
    const [write] = t.commands(TransactWriteCommand);
    const [conn, auth, audit] = write!.input.TransactItems!;
    expect(conn!.Put?.Item).toMatchObject({ sk: "CONN#mcp#test", auth: "oauth" });
    expect(auth!.Update).toMatchObject({ Key: { pk: "ROOM#r", sk: "MCPAUTH#test" }, UpdateExpression: "SET sealed = :sealed ADD #version :one" });
    const sealed = String(auth!.Update!.ExpressionAttributeValues![":sealed"]);
    const stored = JSON.parse(unseal(KEY, sealed, "r#test"));
    expect(sealed).not.toContain(stored.tokens.access_token);
    expect(audit!.Put?.Item).toMatchObject({ kind: "connected", detail: "MCP test (127.0.0.1)" });
    expect(t.notify).toHaveBeenCalledWith("r");
    expect(t.bodies.join("\n")).not.toMatch(SECRET_WORDS);
  });

  it("another admin can't finish it, and that uses the flow up", async () => {
    const { t, state, code } = await begun();
    expect(await t.call(finish, { state, code }, { sub: "u2" })).toEqual({
      status: 403, body: { error: "Finish connecting as the admin who started it.", roomId: "r" },
    });
    expect(await t.call(finish, { state, code })).toEqual({ status: 410, body: { error: "This connection attempt expired. Try again." } });
    expect(t.commands(TransactWriteCommand)).toEqual([]);
  });

  it("a refusal on the server's side is shown with its error, and the browser knows which room", async () => {
    const { t, state, error } = await begun({ consent: "deny" });
    expect(await t.call(finish, { state, error })).toEqual({
      status: 502, body: { error: "127.0.0.1 didn't allow access (access_denied).", roomId: "r" },
    });
  });

  it("an unknown or missing state is the expired copy", async () => {
    const t = setup();
    for (const state of ["nope", "", undefined]) {
      expect((await t.call(finish, { state, code: "c" })).body).toEqual({ error: "This connection attempt expired. Try again." });
    }
  });
});

describe("a connected server", () => {
  it("refresh tools rereads the list; remove deletes it and its sign-in, logged; both tell the room", async () => {
    const server = await start({ auth: "none", extraTools: 2 });
    const t = setup({ u1: "admin" }, [{ ...mcpRow("test"), url: server.url }]);
    const refreshed = await t.call("POST /rooms/{roomId}/connections/mcp/{name}/refresh");
    expect(refreshed.status).toBe(200);
    const [update] = t.commands(UpdateCommand);
    expect(update!.input.ExpressionAttributeValues).toMatchObject({ ":count": 6, ":connected": "connected" });
    const removed = await t.call("DELETE /rooms/{roomId}/connections/mcp/{name}");
    expect(removed.status).toBe(204);
    const [conn, auth, audit] = t.commands(TransactWriteCommand)[0]!.input.TransactItems!;
    expect(conn!.Delete?.Key).toEqual({ pk: "ROOM#r", sk: "CONN#mcp#test" });
    expect(auth!.Delete?.Key).toEqual({ pk: "ROOM#r", sk: "MCPAUTH#test" });
    expect(audit!.Put?.Item).toMatchObject({ kind: "disconnected", detail: "MCP test" });
    expect(t.notify).toHaveBeenCalledTimes(2);
  });

  it("an unknown name is a 404 for refresh and reconnect, and removing it changes nothing", async () => {
    const t = setup();
    expect((await t.call("POST /rooms/{roomId}/connections/mcp/{name}/refresh")).body).toEqual({ error: "This room has no MCP server called test." });
    expect((await t.call("POST /rooms/{roomId}/connections/mcp/{name}/reconnect", { redirectUri: REDIRECT })).status).toBe(404);
    expect((await t.call("DELETE /rooms/{roomId}/connections/mcp/{name}")).status).toBe(204);
    expect(t.commands(TransactWriteCommand)).toEqual([]);
  });
});
