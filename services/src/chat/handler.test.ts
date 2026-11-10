import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "./handler.js";
import { NotFound } from "../rooms/model.js";

process.env.WS_URL = "ws://sockets.example/live";

const ev = (routeKey: string, o: { params?: Record<string, string>; query?: Record<string, string> } = {}) => ({
  routeKey,
  pathParameters: o.params ?? {},
  queryStringParameters: o.query,
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

const fakeHistory = (impl: (...args: unknown[]) => unknown = async () => ({ messages: [] })) => ({ history: vi.fn(impl) as any });
const body = (res: { body?: string }) => JSON.parse(res.body as string);
const params = { roomId: "r1", chatId: "c1" };
const HISTORY = "GET /rooms/{roomId}/chats/{chatId}/messages";

describe("chat handler", () => {
  it("POST /ws/ticket issues a ticket for the caller and says where to connect", async () => {
    const issue = vi.fn(async () => ({ ticket: "t1" }));
    const res = await makeHandler(fakeHistory(), issue)(ev("POST /ws/ticket"));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ ticket: "t1", url: "ws://sockets.example/live" });
    expect(issue).toHaveBeenCalledWith({ userId: "u1", username: "aman" });
  });

  it("GET messages passes the caller, the chat and the numeric cursor to the repo", async () => {
    const repo = fakeHistory(async () => ({ messages: [{ seq: 2 }] }));
    const res = await makeHandler(repo, vi.fn())(ev(HISTORY, { params, query: { after: "1" } }));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ messages: [{ seq: 2 }] });
    expect(repo.history).toHaveBeenCalledWith({ userId: "u1", username: "aman" }, "r1", "c1", { after: 1 });
  });

  it("a cursor that isn't a whole number is a 400", async () => {
    const res = await makeHandler(fakeHistory(), vi.fn())(ev(HISTORY, { params, query: { before: "abc" } }));
    expect(res.statusCode).toBe(400);
  });

  it("maps repo errors to their status", async () => {
    const repo = fakeHistory(async () => { throw new NotFound("Chat not found."); });
    const res = await makeHandler(repo, vi.fn())(ev(HISTORY, { params }));
    expect(res.statusCode).toBe(404);
    expect(body(res)).toEqual({ error: "Chat not found." });
  });
});
