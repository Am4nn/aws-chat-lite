import { describe, expect, it, vi } from "vitest";
import { makeHandler } from "./handler.js";

const ev = (routeKey: string, opts: { body?: unknown; id?: string } = {}) => ({
  routeKey,
  body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  pathParameters: opts.id ? { id: opts.id } : undefined,
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

const keys = { publicKey: "BPublicKey", privateKey: "private-key-material", subject: "mailto:a@b.c" };

function handler(pushKeys: object = keys) {
  const repo = { save: vi.fn(async () => ({ id: "abc" })), remove: vi.fn(async () => {}) };
  return { repo, handle: makeHandler(repo, async () => pushKeys) };
}

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), auth: Buffer.alloc(16).toString("base64url") },
};

describe("push routes", () => {
  it("GET /push/key gives the browser the public key and nothing else", async () => {
    const res = await handler().handle(ev("GET /push/key"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ publicKey: "BPublicKey" });
    expect(res.body).not.toContain("private-key-material");
  });

  it("GET /push/key is null where push has no keys, which hides the toggle", async () => {
    expect(JSON.parse((await handler({}).handle(ev("GET /push/key"))).body!)).toEqual({ publicKey: null });
  });

  it("PUT /me/push saves a real push subscription for the caller", async () => {
    const { repo, handle } = handler();
    const res = await handle(ev("PUT /me/push", { body: { ...subscription, expirationTime: null } }));
    expect(res).toMatchObject({ statusCode: 200, body: JSON.stringify({ id: "abc" }) });
    expect(repo.save).toHaveBeenCalledWith("u1", subscription);
  });

  it("PUT /me/push refuses an endpoint that isn't a push service", async () => {
    const { repo, handle } = handler();
    const res = await handle(ev("PUT /me/push", { body: { ...subscription, endpoint: "http://169.254.169.254/x" } }));
    expect(res.statusCode).toBe(400);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("DELETE /me/push/{id} forgets one of the caller's devices", async () => {
    const { repo, handle } = handler();
    expect((await handle(ev("DELETE /me/push/{id}", { id: "abc" }))).statusCode).toBe(204);
    expect(repo.remove).toHaveBeenCalledWith("u1", "abc");
  });
});
