import { describe, it, expect, vi } from "vitest";
import { makeHandler } from "./handler.js";
import { Forbidden, NotFound, Conflict, Gone, ValidationError } from "../lib/errors.js";
import type { RoomsRepo } from "./repo.js";

/** A fake repo: each method resolves `value` or rejects with `error`. */
function fakeRepo(over: Partial<Record<keyof RoomsRepo, unknown>> = {}): RoomsRepo {
  const base: Record<string, unknown> = {};
  const names: (keyof RoomsRepo)[] = ["createRoom", "listMyRooms", "getRoomView", "createChat", "setRole", "removeMember",
    "rotateInvite", "getInvite", "revokeInvite", "previewInvite", "acceptInvite", "setChatPrefs", "leaveRoom", "archiveRoom", "setDefaultModel", "setSandboxInternet"];
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

const status = async (repo: RoomsRepo, e: any) => (await makeHandler(repo, vi.fn())(e)).statusCode;

describe("rooms handler", () => {
  it("GET /me reports creator from the token", async () => {
    const res = await makeHandler(fakeRepo(), vi.fn())(ev("GET /me", { groups: "[creators]" }));
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
      "DELETE /rooms/{roomId}/invite", "GET /invites/{code}", "POST /invites/{code}/accept",
      "PATCH /rooms/{roomId}/chats/{chatId}/prefs", "POST /rooms/{roomId}/leave", "POST /rooms/{roomId}/archive",
      "PUT /rooms/{roomId}/model"];
    for (const r of routes) {
      const s = await status(fakeRepo(), ev(r, { params: { roomId: "r1", userId: "u2", code: "c" }, body: { name: "x", role: "admin", model: "auto" } }));
      expect([200, 201, 204], r).toContain(s);
    }
  });

  it("writes that change what members see tell the room to refetch; reads and invite admin don't", async () => {
    const repo = fakeRepo({ acceptInvite: { roomId: "r9" } });
    const p = { params: { roomId: "r1", userId: "u2", code: "c", chatId: "c1" }, body: { name: "x", role: "admin", muted: true, model: "auto" } };
    const notified = async (route: string) => {
      const notify = vi.fn(async (_roomId: string) => {});
      await makeHandler(repo, notify)(ev(route, p));
      return notify.mock.calls.map(([roomId]) => roomId);
    };
    for (const r of ["POST /rooms/{roomId}/chats", "PATCH /rooms/{roomId}/members/{userId}", "DELETE /rooms/{roomId}/members/{userId}",
      "POST /rooms/{roomId}/leave", "POST /rooms/{roomId}/archive", "PUT /rooms/{roomId}/model"]) {
      expect(await notified(r), r).toEqual(["r1"]);
    }
    expect(await notified("POST /invites/{code}/accept")).toEqual(["r9"]);
    for (const r of ["GET /rooms/{roomId}", "POST /rooms/{roomId}/invite", "PATCH /rooms/{roomId}/chats/{chatId}/prefs"]) {
      expect(await notified(r), r).toEqual([]);
    }
  });

  it("leaving also tells the leaver's own sockets, which the room fan-out no longer reaches", async () => {
    const notify = vi.fn(async (_roomId: string, _alsoUserId?: string) => {});
    await makeHandler(fakeRepo(), notify)(ev("POST /rooms/{roomId}/leave", { params: { roomId: "r1" } }));
    expect(notify).toHaveBeenCalledWith("r1", "u1");
  });

  it("removing someone also tells the removed member's sockets, so their open room can send them home", async () => {
    const notify = vi.fn(async (_roomId: string, _alsoUserId?: string) => {});
    await makeHandler(fakeRepo(), notify)(ev("DELETE /rooms/{roomId}/members/{userId}", { params: { roomId: "r1", userId: "u2" } }));
    expect(notify).toHaveBeenCalledWith("r1", "u2");
  });

  it("a failed broadcast is logged, and the write it follows still succeeds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = vi.fn(async () => { throw new Error("socket API down"); });
    const res = await makeHandler(fakeRepo(), notify)(ev("POST /rooms/{roomId}/archive", { params: { roomId: "r1" } }));
    expect(res.statusCode).toBe(200);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("a failed write tells nobody", async () => {
    const notify = vi.fn(async () => {});
    await makeHandler(fakeRepo({ leaveRoom: new Forbidden("owner") }), notify)(ev("POST /rooms/{roomId}/leave", { params: { roomId: "r1" } }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("PATCH prefs passes the chat and the muted flag", async () => {
    const setChatPrefs = vi.fn(async () => ({ muted: true }));
    const repo = { ...fakeRepo(), setChatPrefs } as unknown as RoomsRepo;
    const res = await makeHandler(repo, vi.fn())(ev("PATCH /rooms/{roomId}/chats/{chatId}/prefs", { params: { roomId: "r1", chatId: "c1" }, body: { muted: true } }));
    expect(JSON.parse(res.body as string)).toEqual({ muted: true });
    expect(setChatPrefs).toHaveBeenCalledWith("r1", "u1", "c1", true);
  });

  it("PUT /model: an unknown model is a 400, a member is a 403, an admin sets it and the room hears once", async () => {
    const put = (repo: RoomsRepo, notify: () => Promise<void>, model: unknown) =>
      makeHandler(repo, notify)(ev("PUT /rooms/{roomId}/model", { params: { roomId: "r" }, body: { model } }));
    const setDefaultModel = vi.fn(async (_u: unknown, _r: string, pick: string) => pick);
    const repo = { ...fakeRepo(), setDefaultModel } as unknown as RoomsRepo;
    const notify = vi.fn(async () => {});

    expect((await put(repo, notify, "gpt")).statusCode).toBe(400);
    expect((await put(repo, notify, undefined)).statusCode).toBe(400);
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect((await put(fakeRepo({ setDefaultModel: new Forbidden("no") }), notify, "haiku")).statusCode).toBe(403);
    expect(notify).not.toHaveBeenCalled();

    const res = await put(repo, notify, "haiku");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ defaultModel: "haiku" });
    expect(setDefaultModel).toHaveBeenCalledWith({ userId: "u1", username: "aman" }, "r", "haiku");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("r", undefined);
  });

  it("PUT /sandbox: a member is a 403, an admin turns internet on and the room hears, a non-boolean is a 400", async () => {
    const put = (repo: RoomsRepo, notify: () => Promise<void>, internet: unknown) =>
      makeHandler(repo, notify)(ev("PUT /rooms/{roomId}/sandbox", { params: { roomId: "r" }, body: { internet } }));
    const setSandboxInternet = vi.fn(async (_u: unknown, _r: string, on: boolean) => on);
    const repo = { ...fakeRepo(), setSandboxInternet } as unknown as RoomsRepo;
    const notify = vi.fn(async () => {});

    expect((await put(fakeRepo({ setSandboxInternet: new Forbidden("no") }), notify, true)).statusCode).toBe(403);
    expect((await put(repo, notify, "yes")).statusCode).toBe(400);
    expect(setSandboxInternet).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    const res = await put(repo, notify, true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ sandboxInternet: true });
    expect(setSandboxInternet).toHaveBeenCalledWith({ userId: "u1", username: "aman" }, "r", true);
    expect(notify).toHaveBeenCalledWith("r", undefined);
  });

  it("unknown route is a 404", async () => {
    expect(await status(fakeRepo(), ev("GET /nope"))).toBe(404);
  });
});
