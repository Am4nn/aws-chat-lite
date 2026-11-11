import { createECDH, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import webpush from "web-push";
import { docClient } from "../lib/db.js";
import { fakeSender, liveSender } from "./send.js";
import type { PushNote, StoredSubscription } from "./types.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const vapid = webpush.generateVAPIDKeys();
const keys = { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: "mailto:push@chat-lite.test" };
const device = createECDH("prime256v1");
device.generateKeys();
const sub: StoredSubscription = {
  id: "s1", userId: "u1", createdAt: "2026-11-11T10:00:00.000Z", endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: device.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
};
const note: PushNote = { title: "#pr-check needs approval", body: "dev: Comment", url: "/r/R/t/7", tag: "approval-RUN-3", urgency: "high" };

describe("liveSender", () => {
  it("sends the note encrypted for the device, signed with VAPID, for an hour at most", async () => {
    const send = vi.fn(async () => ({ statusCode: 201, body: "", headers: {} }));
    expect(await liveSender(keys, send)(sub, note)).toBe("ok");
    const [target, payload, options] = send.mock.calls[0] as unknown as [webpush.PushSubscription, string, webpush.RequestOptions];
    expect(target).toEqual({ endpoint: sub.endpoint, keys: sub.keys });
    expect(JSON.parse(payload)).toEqual(note);
    expect(options).toMatchObject({ TTL: 3600, urgency: "high", timeout: 5000, vapidDetails: keys });
    expect(options?.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const request = webpush.generateRequestDetails(target, payload, options);
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(String(request.headers.Authorization)).toMatch(/^vapid t=/);
  });

  it("calls a device the push service no longer knows gone, and logs other failures by status only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = (statusCode: number) => vi.fn(async () => {
      throw Object.assign(new Error(`Received unexpected response code ${sub.endpoint}`), { statusCode, endpoint: sub.endpoint });
    });
    expect(await liveSender(keys, failing(410))(sub, note)).toBe("gone");
    expect(await liveSender(keys, failing(404))(sub, note)).toBe("gone");
    expect(await liveSender(keys, failing(429))(sub, note)).toBe("failed");
    expect(error).toHaveBeenCalledWith("push send failed", 429);
    expect(JSON.stringify(error.mock.calls)).not.toContain("fcm.googleapis.com");
  });

  it("refuses to start without every VAPID field", () => {
    expect(() => liveSender({ publicKey: keys.publicKey, privateKey: keys.privateKey })).toThrow("VAPID");
  });
});

describe("fakeSender", () => {
  it("records the note on the user for a day instead of sending it", async () => {
    const put = vi.spyOn(docClient(), "send").mockResolvedValue({} as never);
    expect(await fakeSender()(sub, note)).toBe("ok");
    const { Item } = (put.mock.calls[0][0] as PutCommand).input;
    expect(Item).toMatchObject({ pk: "USER#u1", note });
    expect(Item!.sk).toMatch(/^PUSHED#\d{4}-\d\d-\d\dT[\d:.]+Z#s1$/);
    expect(Item!.ttl - Date.now() / 1000).toBeCloseTo(86400, -1);
  });
});
