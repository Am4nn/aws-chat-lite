import { describe, it, expect } from "vitest";
import { makeHandler } from "./handler.js";
import { Forbidden, NotFound, Conflict, Gone, ValidationError } from "./model.js";
import type { RoomsRepo } from "./repo.js";

/** A fake repo: each method resolves `value` or rejects with `error`. */
function fakeRepo(over: Partial<Record<keyof RoomsRepo, unknown>> = {}): RoomsRepo {
  const base: Record<string, unknown> = {};
  const names: (keyof RoomsRepo)[] = ["createRoom", "listMyRooms", "getRoomView", "createChat", "setRole", "removeMember",
    "rotateInvite", "getInvite", "revokeInvite", "previewInvite", "acceptInvite"];
  for (const n of names) {
    const v = over[n];
    base[n] = async () => { if (v instanceof Error) throw v; return v ?? {}; };
  }
  return base as unknown as RoomsRepo;
}

const ev = (routeKey: string, o: { body?: unknown; params?: Record<string, string>; groups?: string | string[] } = {}) => ({
  routeKey,
  body: o.body === undefined ? undefined : JSON.stringify(o.body),
  pathParameters: o.params ?? {},
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman", ...(o.groups ? { "cognito:groups": o.groups } : {}) } } } },
}) as any;

const status = async (repo: RoomsRepo, e: any) => (await makeHandler(repo)(e)).statusCode;

describe("rooms handler", () => {
  it("GET /me reports creator from the token", async () => {
    const res = await makeHandler(fakeRepo())(ev("GET /me", { groups: "[creators]" }));
    expect(JSON.parse(res.body as string)).toEqual({ userId: "u1", username: "aman", isCreator: true });
  });

  it("POST /rooms: 403 for non-creators, 201 for creators", async () => {
    expect(await status(fakeRepo(), ev("POST /rooms", { body: { name: "dev" } }))).toBe(403);
    expect(await status(fakeRepo({ createRoom: { roomId: "r1" } }), ev("POST /rooms", { body: { name: "dev" }, groups: ["creators"] }))).toBe(201);
  });

  it("maps repo errors to 400/403/404/409/410", async () => {
    const p = { params: { roomId: "r1" }, body: { name: "x" } };
    expect(await status(fakeRepo({ createChat: new ValidationError("bad") }), ev("POST /rooms/{roomId}/chats", p))).toBe(400);
    expect(await status(fakeRepo({ createChat: new Forbidden("no") }), ev("POST /rooms/{roomId}/chats", p))).toBe(403);
    expect(await status(fakeRepo({ getRoomView: new NotFound("no") }), ev("GET /rooms/{roomId}", p))).toBe(404);
    expect(await status(fakeRepo({ createChat: new Conflict("taken") }), ev("POST /rooms/{roomId}/chats", p))).toBe(409);
    expect(await status(fakeRepo({ acceptInvite: new Gone("expired") }), ev("POST /invites/{code}/accept", { params: { code: "c" } }))).toBe(410);
  });

  it("invalid JSON is a 400", async () => {
    const e = ev("POST /rooms", { groups: ["creators"] });
    e.body = "{nope";
    expect(await status(fakeRepo(), e)).toBe(400);
  });

  it("every route in the table answers", async () => {
    const routes = ["GET /rooms", "GET /rooms/{roomId}", "POST /rooms/{roomId}/chats", "PATCH /rooms/{roomId}/members/{userId}",
      "DELETE /rooms/{roomId}/members/{userId}", "POST /rooms/{roomId}/invite", "GET /rooms/{roomId}/invite",
      "DELETE /rooms/{roomId}/invite", "GET /invites/{code}", "POST /invites/{code}/accept"];
    for (const r of routes) {
      const s = await status(fakeRepo(), ev(r, { params: { roomId: "r1", userId: "u2", code: "c" }, body: { name: "x", role: "admin" } }));
      expect([200, 201, 204], r).toContain(s);
    }
  });

  it("unknown route is a 404", async () => {
    expect(await status(fakeRepo(), ev("GET /nope"))).toBe(404);
  });
});
