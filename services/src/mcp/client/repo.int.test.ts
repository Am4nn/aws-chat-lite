import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditRepo } from "../../audit/repo.js";
import { connectionsRepo } from "../../connections/repo.js";
import { docClient, tableName } from "../../lib/db.js";
import { roomsRepo } from "../../rooms/repo.js";
import { connectTestServer } from "../testing/connect.js";
import { startMcpTestServer } from "../testing/server.js";
import { guardedFetch } from "./fetch.js";
import { mcpRepo } from "./repo.js";
import { tokenKey, unseal } from "./seal.js";

// Runs against DynamoDB and Secrets Manager on Floci: npm run floci:up && npm run deploy:local, then
// npm -w services run test:int. The MCP test servers run in this process on 127.0.0.1.
const HOSTS = ["127.0.0.1"];
const REDIRECT = "http://localhost:3000/bff/mcp/callback";
const user = (name: string) => ({ userId: randomUUID(), username: name });
const quiet = async () => {};

type TestServer = Awaited<ReturnType<typeof startMcpTestServer>>;
let oauth: TestServer;
let open: TestServer;
let denying: TestServer;
beforeAll(async () => {
  [oauth, open, denying] = await Promise.all([startMcpTestServer(), startMcpTestServer({ auth: "none" }), startMcpTestServer({ consent: "deny" })]);
});
afterAll(() => Promise.all([oauth, open, denying].map((s) => s.close())));

/** A room with its owner and a second admin. */
async function room() {
  const owner = user("owner");
  const admin = user("admin");
  const rooms = roomsRepo();
  const { roomId } = await rooms.createRoom(owner, "Tools");
  await rooms.acceptInvite((await rooms.rotateInvite(roomId, owner.userId)).code, admin);
  await rooms.setRole(roomId, owner.userId, admin.userId, "admin");
  return { owner, admin, roomId };
}

function repoWith(fetch = guardedFetch({ localHosts: HOSTS })) {
  return mcpRepo({ fetch, hosts: HOSTS, key: tokenKey, notifyRoom: quiet });
}

const rawItem = async (roomId: string, sk: string) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk }, ConsistentRead: true }))).Item;

/** Starts a flow and walks the browser through the server's authorize page, stopping before the finish. */
async function begun(server: TestServer, admin: ReturnType<typeof user>, roomId: string) {
  const repo = repoWith();
  const started = await repo.connect(admin, roomId, { name: "test", url: server.url, redirectUri: REDIRECT });
  if (!("authorizeUrl" in started)) throw new Error("The server should want OAuth.");
  const q = new URL((await guardedFetch({ localHosts: HOSTS })(started.authorizeUrl)).headers.get("location")!).searchParams;
  return { repo, state: q.get("state"), code: q.get("code") ?? undefined, error: q.get("error") ?? undefined };
}

describe("room MCP connections on Floci", () => {
  it("connects the test server through OAuth, with its 4 tools, and the room's connections list it", async () => {
    const { owner, roomId } = await room();
    const connection = await connectTestServer(roomId, owner, { serverUrl: oauth.url, localHosts: HOSTS });
    expect(connection).toMatchObject({ name: "test", auth: "oauth", status: "connected", toolCount: 4 });
    expect(connection.tools).toHaveLength(4);
    expect((await connectionsRepo().get(roomId)).mcp).toEqual([connection]);
    expect((await rawItem(roomId, "MCPAUTH#test"))?.version).toBe(1);
  });

  it("stores the tokens sealed to the room: no token text at rest, and a copy in another room won't open", async () => {
    const a = await room();
    const b = await room();
    await connectTestServer(a.roomId, a.owner, { serverUrl: oauth.url, localHosts: HOSTS });
    const item = (await rawItem(a.roomId, "MCPAUTH#test"))!;
    const auth = JSON.parse(unseal(await tokenKey(), String(item.sealed), `${a.roomId}#test`));
    expect(JSON.stringify(item)).not.toContain(auth.tokens.access_token);
    expect(JSON.stringify(item)).not.toContain(auth.tokens.refresh_token);
    await docClient().send(new PutCommand({ TableName: tableName(), Item: { ...item, pk: `ROOM#${b.roomId}` } }));
    expect(await repoWith().tokenStore(b.roomId, "test").load()).toBeNull();
    expect(await repoWith().tokenStore(a.roomId, "test").load()).toMatchObject({ version: 1 });
  });

  it("only the admin who started a flow can finish it, and a refused finish uses the flow up", async () => {
    const { owner, admin, roomId } = await room();
    const { repo, state, code } = await begun(oauth, owner, roomId);
    await expect(repo.finish(admin, { state, code })).rejects.toMatchObject({
      roomId, error: { message: "Finish connecting as the admin who started it." },
    });
    await expect(repo.finish(owner, { state, code })).rejects.toThrow("This connection attempt expired. Try again.");
    expect((await connectionsRepo().get(roomId)).mcp).toEqual([]);
  });

  it("a server that refuses access says so", async () => {
    const { owner, roomId } = await room();
    const { repo, state, error } = await begun(denying, owner, roomId);
    await expect(repo.finish(owner, { state, error })).rejects.toMatchObject({ error: { message: "127.0.0.1 didn't allow access (access_denied)." } });
  });

  it("a server without sign-in connects with no stored tokens; names are unique and a room takes 5", async () => {
    const { owner, roomId } = await room();
    for (const name of ["a", "b", "c", "d", "e"]) await connectTestServer(roomId, owner, { serverUrl: open.url, localHosts: HOSTS, name });
    expect((await connectionsRepo().get(roomId)).mcp.map((c) => [c.name, c.auth, c.status])).toEqual(
      ["a", "b", "c", "d", "e"].map((n) => [n, "none", "connected"]),
    );
    expect(await rawItem(roomId, "MCPAUTH#a")).toBeUndefined();
    const repo = repoWith();
    await expect(repo.connect(owner, roomId, { name: "a", url: open.url, redirectUri: REDIRECT })).rejects.toThrow(
      "This room already has an MCP server called a.",
    );
    await expect(repo.connect(owner, roomId, { name: "f", url: open.url, redirectUri: REDIRECT })).rejects.toThrow(
      "A room can connect up to 5 MCP servers.",
    );
  });

  it("removing deletes the connection and its tokens, revokes them on the server, and is logged", async () => {
    const { owner, roomId } = await room();
    await connectTestServer(roomId, owner, { serverUrl: oauth.url, localHosts: HOSTS });
    const fetch = vi.fn(guardedFetch({ localHosts: HOSTS }));
    await repoWith(fetch).remove(owner, roomId, "test");
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain(`${oauth.origin}/revoke`);
    expect(await rawItem(roomId, "LINK#mcp#test")).toBeUndefined();
    expect(await rawItem(roomId, "MCPAUTH#test")).toBeUndefined();
    const [entry] = (await auditRepo().list(roomId)).entries;
    expect(entry).toMatchObject({ kind: "disconnected", actor: "owner", detail: "MCP test" });
  });

  it("a save over a version someone already moved past is refused; a reconnect moves the version on", async () => {
    const { owner, roomId } = await room();
    await connectTestServer(roomId, owner, { serverUrl: oauth.url, localHosts: HOSTS });
    const store = repoWith().tokenStore(roomId, "test");
    const { auth } = (await store.load())!;
    expect(await store.save(auth, 1)).toBe(true);
    expect(await store.save(auth, 1)).toBe(false);
    expect((await store.load())?.version).toBe(2);

    const registrations = oauth.registrations;
    const again = await repoWith().reconnect(owner, roomId, "test", REDIRECT);
    if (!("authorizeUrl" in again)) throw new Error("The server should want OAuth.");
    const q = new URL((await guardedFetch({ localHosts: HOSTS })(again.authorizeUrl)).headers.get("location")!).searchParams;
    await repoWith().finish(owner, { state: q.get("state"), code: q.get("code") });
    expect((await store.load())?.version).toBe(3);
    expect(oauth.registrations).toBe(registrations);
  });

  it("refreshing tools rereads the server's list", async () => {
    const { owner, roomId } = await room();
    await connectTestServer(roomId, owner, { serverUrl: oauth.url, localHosts: HOSTS });
    const refreshed = await repoWith().refreshTools(owner, roomId, "test");
    expect(refreshed).toMatchObject({ name: "test", status: "connected", toolCount: 4 });
    expect((await connectionsRepo().get(roomId)).mcp).toEqual([refreshed]);
  });
});
