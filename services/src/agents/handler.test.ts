import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import type { Role } from "../rooms/access.js";
import { makeHandler } from "./handler.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1", STAGE: "local" });

afterEach(() => vi.restoreAllMocks());

const scout = {
  agentId: "a1", name: "scout", instructions: "Find things.", tools: ["web"], model: "room", builtIn: false,
  createdBy: "u2", createdByName: "bee", createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
};
const schedule = (scheduleId: string, agentId: string) => ({ pk: "ROOM#r", sk: `SCHED#${scheduleId}`, scheduleId, agentId, createdAt: scheduleId });
const entry = { memoryId: "ab12cd34", text: "Deploys go out on Thursdays.", private: true, updatedBy: "aman" };

/** The room as the caller with `role` sees it: `scout` (made by someone else), three schedules, no GitHub. */
function fakeTable(role: Role, rows: { github?: boolean } = {}) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const sk = String(c.input.Key?.sk);
      if (sk.startsWith("MEMBER#")) return { Item: { role } };
      if (sk === "AGENT#a1") return { Item: { pk: "ROOM#r", sk, ...scout } };
      if (sk === "LINK#github" && rows.github) return { Item: { installationId: 1, repos: ["o/r"] } };
      return {};
    }
    if (c instanceof QueryCommand) {
      const values = JSON.stringify(c.input.ExpressionAttributeValues);
      if (values.includes("SCHED#")) return { Items: [schedule("s1", "a1"), schedule("s2", "a1"), schedule("s3", "other")] };
      if (values.includes('"AGENT#"')) return { Items: [{ pk: "ROOM#r", sk: "AGENT#a1", ...scout }] };
      return { Items: [] };
    }
    if (c instanceof UpdateCommand) return { Attributes: { pk: "ROOM#r", sk: `MEMORY#${entry.memoryId}`, ...entry } };
    return {};
  }) as never);
}

const ev = (routeKey: string, body?: unknown, params: Record<string, string> = {}) => ({
  routeKey,
  body: body === undefined ? undefined : JSON.stringify(body),
  pathParameters: { roomId: "r", ...params },
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

async function call(role: Role, routeKey: string, body?: unknown, params?: Record<string, string>, rows?: { github?: boolean }) {
  const send = fakeTable(role, rows);
  const trigger = { remove: vi.fn(async (_scheduleId: string) => {}) };
  const res = await makeHandler(trigger)(ev(routeKey, body, params));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body as string) : undefined, send, trigger };
}

const transactions = (send: ReturnType<typeof fakeTable>) => send.mock.calls.map(([c]) => c).filter((c) => c instanceof TransactWriteCommand);

describe("agents routes", () => {
  it("GET lists the built-in first and the kinds the room offers", async () => {
    const res = await call("member", "GET /rooms/{roomId}/agents");
    expect(res.status).toBe(200);
    expect(res.body.agents.map((a: { name: string }) => a.name)).toEqual(["agent", "scout"]);
    expect(res.body.kinds).toEqual(["images", "sandbox", "web"]);
    expect(res.body.brief).toMatch(/^You work inside chat-lite, a team chat room/);
    expect((await call("member", "GET /rooms/{roomId}/agents", undefined, {}, { github: true })).body.kinds).toEqual(["github", "images", "sandbox", "web"]);
  });

  it("POST refuses a bad name, before any write", async () => {
    const res = await call("member", "POST /rooms/{roomId}/agents", { name: "1bot", tools: ["web"] });
    expect(res).toMatchObject({ status: 400, body: { error: "Agent names use a-z, 0-9 and dashes, 2 to 32 characters, starting with a letter." } });
    expect(transactions(res.send)).toEqual([]);
  });

  it("POST refuses a tool kind the room doesn't offer", async () => {
    const res = await call("member", "POST /rooms/{roomId}/agents", { name: "critic", tools: ["github", "web"] });
    expect(res).toMatchObject({ status: 400, body: { error: "This room has no github connection." } });
    expect(transactions(res.send)).toEqual([]);
  });

  it("POST creates the agent: 201 with it", async () => {
    const res = await call("member", "POST /rooms/{roomId}/agents", { name: " Critic ", instructions: "Be blunt.", tools: ["web"], model: "haiku" });
    expect(res.status).toBe(201);
    expect(res.body.agent).toMatchObject({ name: "critic", instructions: "Be blunt.", tools: ["web"], model: "haiku", createdBy: "u1" });
  });

  it("PATCH by a member who didn't make the agent is a 403", async () => {
    const res = await call("member", "PATCH /rooms/{roomId}/agents/{agentId}", { instructions: "Mine now." }, { agentId: "a1" });
    expect(res).toMatchObject({ status: 403, body: { error: "Only its creator or an admin can change @scout." } });
  });

  it("PATCH may keep a kind the room no longer offers, but not add one", async () => {
    const kept = await call("admin", "PATCH /rooms/{roomId}/agents/{agentId}", { tools: ["web"] }, { agentId: "a1" });
    expect(kept).toMatchObject({ status: 200, body: { agent: { name: "scout", tools: ["web"] } } });
    const added = await call("admin", "PATCH /rooms/{roomId}/agents/{agentId}", { tools: ["mcp", "web"] }, { agentId: "a1" });
    expect(added).toMatchObject({ status: 400, body: { error: "This room has no mcp connection." } });
  });

  it("DELETE removes the agent's schedules and their triggers", async () => {
    const res = await call("admin", "DELETE /rooms/{roomId}/agents/{agentId}", {}, { agentId: "a1" });
    expect(res.status).toBe(204);
    expect(res.trigger.remove.mock.calls).toEqual([["s1"], ["s2"]]);
    const deleted = transactions(res.send).flatMap((t) => t.input.TransactItems!).map((i) => i.Delete?.Key?.sk).filter(Boolean);
    expect(deleted).toEqual(["AGENTNAME#scout", "SCHED#s1", "SCHED#s2"]);
  });

  it("DELETE of the built-in is a 400 and touches no schedule", async () => {
    const res = await call("owner", "DELETE /rooms/{roomId}/agents/{agentId}", {}, { agentId: "agent" });
    expect(res).toMatchObject({ status: 400, body: { error: "The built-in @agent can't be renamed, deleted or copied." } });
    expect(res.trigger.remove).not.toHaveBeenCalled();
  });
});

describe("memory routes", () => {
  it("PATCH answers with the entry, still private", async () => {
    const res = await call("member", "PATCH /rooms/{roomId}/memory/{memoryId}", { text: "Deploys go out on Thursdays." }, { memoryId: "ab12cd34" });
    expect(res).toMatchObject({ status: 200, body: { entry: { memoryId: "ab12cd34", private: true } } });
  });

  it("DELETE is a 204", async () => {
    expect((await call("member", "DELETE /rooms/{roomId}/memory/{memoryId}", {}, { memoryId: "ab12cd34" })).status).toBe(204);
  });
});
