import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { docClient } from "../lib/db.js";
import { forgetConnection } from "./connections.js";
import { markDisconnected } from "./presence.js";
import { broadcastToRoom, sendToConnection, sendToUser } from "./broadcast.js";

vi.mock("./connections.js", () => ({ forgetConnection: vi.fn() }));
vi.mock("./presence.js", async (actual) => ({ ...await actual<object>(), markDisconnected: vi.fn() }));

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1", WS_CALLBACK_URL: "http://ws.test/live" });

afterEach(() => vi.restoreAllMocks());

/** Room r1 has one other member, u2, on socket "peer"; posting to socket "dead" answers Gone. */
function fakeAws() {
  vi.spyOn(docClient(), "send").mockImplementation((async (c: QueryCommand) => {
    const { ":p": pk, ":c": conns } = c.input.ExpressionAttributeValues!;
    if (pk === "ROOM#r1") return { Items: conns ? [{ sk: "CONN#peer", userId: "u2" }] : [{ userId: "u2" }] };
    return { Items: pk === "USER#u2" ? [{ sk: "CONN#peer" }, { sk: "CONN#tab2" }] : [] };
  }) as never);
  const posts: { to: string; event: Record<string, unknown> }[] = [];
  vi.spyOn(ApiGatewayManagementApiClient.prototype, "send").mockImplementation((async (c: PostToConnectionCommand) => {
    if (c.input.ConnectionId === "dead") throw Object.assign(new Error("gone"), { name: "GoneException" });
    posts.push({ to: c.input.ConnectionId!, event: JSON.parse(String(c.input.Data)) });
  }) as never);
  return posts;
}

describe("sendToConnection", () => {
  it("a socket found Gone is cleaned up and its owner announced offline to their rooms", async () => {
    const posts = fakeAws();
    vi.mocked(forgetConnection).mockResolvedValue({ userId: "u1", roomIds: ["r1"] });
    vi.mocked(markDisconnected).mockResolvedValue({ conns: 0, lastSeen: "2026-11-11T00:00:00.000Z" });
    await sendToConnection("dead", { type: "pong" });
    expect(forgetConnection).toHaveBeenCalledWith("dead", { gone: true });
    expect(posts).toEqual([{ to: "peer", event: { type: "presence", userId: "u1", online: false, lastSeen: "2026-11-11T00:00:00.000Z" } }]);
  });

  it("announces nothing when the socket was already counted off", async () => {
    const posts = fakeAws();
    vi.mocked(forgetConnection).mockResolvedValue({ userId: "u1", roomIds: ["r1"] });
    vi.mocked(markDisconnected).mockResolvedValue(undefined);
    await sendToConnection("dead", { type: "pong" });
    expect(posts).toEqual([]);
  });
});

describe("sendToUser", () => {
  it("posts to each of the user's sockets but the one excepted", async () => {
    const posts = fakeAws();
    await sendToUser("u2", { type: "pong" }, { exceptConnId: "tab2" });
    expect(posts.map((p) => p.to)).toEqual(["peer"]);
  });
});

describe("broadcastToRoom", () => {
  it("reads every page of the room's subscriptions and members, so a big room misses no one", async () => {
    vi.spyOn(docClient(), "send").mockImplementation((async (c: QueryCommand) => {
      const { ":c": conns } = c.input.ExpressionAttributeValues!;
      const page = c.input.ExclusiveStartKey ? 2 : 1;
      if (conns) return page === 1 ? { Items: [{ sk: "CONN#a", userId: "u1" }], LastEvaluatedKey: { sk: "CONN#a" } } : { Items: [{ sk: "CONN#b", userId: "u2" }] };
      return page === 1 ? { Items: [{ userId: "u1" }], LastEvaluatedKey: { sk: "MEMBER#u1" } } : { Items: [{ userId: "u2" }] };
    }) as never);
    const posts: string[] = [];
    vi.spyOn(ApiGatewayManagementApiClient.prototype, "send").mockImplementation((async (c: PostToConnectionCommand) => {
      posts.push(c.input.ConnectionId!);
    }) as never);
    await broadcastToRoom("r1", { type: "pong" });
    expect(posts.sort()).toEqual(["a", "b"]);
  });
});
