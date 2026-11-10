import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "./handler.js";
import { NotFound } from "../lib/errors.js";

process.env.WS_URL = "ws://sockets.example/live";

const ev = (routeKey: string, o: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) => ({
  routeKey,
  pathParameters: o.params ?? {},
  queryStringParameters: o.query,
  body: o.body === undefined ? undefined : JSON.stringify(o.body),
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

const fakeDeps = (over: Record<string, unknown> = {}) => ({
  history: vi.fn(async () => ({ messages: [] })),
  issueTicket: vi.fn(async () => ({ ticket: "t1" })),
  searchRoom: vi.fn(async () => ({ results: [] })),
  uploadForm: vi.fn(async () => ({ url: "u", fields: {}, key: "k" })),
  ...over,
}) as any;
const body = (res: { body?: string }) => JSON.parse(res.body as string);
const caller = { userId: "u1", username: "aman" };
const params = { roomId: "r1", chatId: "c1" };
const HISTORY = "GET /rooms/{roomId}/chats/{chatId}/messages";

describe("chat handler", () => {
  it("POST /ws/ticket issues a ticket for the caller and says where to connect", async () => {
    const deps = fakeDeps();
    const res = await makeHandler(deps)(ev("POST /ws/ticket"));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ ticket: "t1", url: "ws://sockets.example/live" });
    expect(deps.issueTicket).toHaveBeenCalledWith(caller);
  });

  it("GET messages passes the caller, the chat and the numeric cursor to the repo", async () => {
    const deps = fakeDeps({ history: vi.fn(async () => ({ messages: [{ seq: 2 }] })) });
    const res = await makeHandler(deps)(ev(HISTORY, { params, query: { after: "1" } }));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ messages: [{ seq: 2 }] });
    expect(deps.history).toHaveBeenCalledWith(caller, "r1", "c1", { after: 1 });
  });

  it("a cursor that isn't a whole number is a 400", async () => {
    const res = await makeHandler(fakeDeps())(ev(HISTORY, { params, query: { before: "abc" } }));
    expect(res.statusCode).toBe(400);
  });

  it("an empty cursor is a 400, not seq 0", async () => {
    const deps = fakeDeps();
    const res = await makeHandler(deps)(ev(HISTORY, { params, query: { before: "" } }));
    expect(res.statusCode).toBe(400);
    expect(deps.history).not.toHaveBeenCalled();
  });

  it("GET search passes the caller, the room and the raw query", async () => {
    const deps = fakeDeps();
    const res = await makeHandler(deps)(ev("GET /rooms/{roomId}/search", { params, query: { q: "Deploy" } }));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ results: [] });
    expect(deps.searchRoom).toHaveBeenCalledWith(caller, "r1", "Deploy");
  });

  it("POST attachments returns the upload form for the declared file", async () => {
    const deps = fakeDeps();
    const file = { name: "a.png", size: 3, type: "image/png" };
    const res = await makeHandler(deps)(ev("POST /rooms/{roomId}/attachments", { params, body: file }));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ url: "u", fields: {}, key: "k" });
    expect(deps.uploadForm).toHaveBeenCalledWith(caller, "r1", file);
  });

  it("a body that isn't JSON is a 400", async () => {
    const e = ev("POST /rooms/{roomId}/attachments", { params });
    e.body = "{nope";
    expect((await makeHandler(fakeDeps())(e)).statusCode).toBe(400);
  });

  it("maps repo errors to their status", async () => {
    const deps = fakeDeps({ history: vi.fn(async () => { throw new NotFound("Chat not found."); }) });
    const res = await makeHandler(deps)(ev(HISTORY, { params }));
    expect(res.statusCode).toBe(404);
    expect(body(res)).toEqual({ error: "Chat not found." });
  });
});
