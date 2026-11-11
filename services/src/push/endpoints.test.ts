import { describe, expect, it } from "vitest";
import { ValidationError } from "../lib/errors.js";
import { subscriptionId, subscriptionOf } from "./endpoints.js";

const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
const auth = Buffer.alloc(16, 2).toString("base64url");
const sub = (endpoint: string, keys = { p256dh, auth }) => ({ endpoint, keys });

describe("subscriptionOf", () => {
  it("accepts the browser push services", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QKabc",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) {
      expect(subscriptionOf({ ...sub(endpoint), expirationTime: null })).toEqual(sub(endpoint));
    }
  });

  it("refuses any other host, scheme or port, so the worker never posts to an address a user chose", () => {
    for (const endpoint of [
      "http://169.254.169.254/x",
      "https://evil.example/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
      "http://fcm.googleapis.com/x",
      "https://user@evil.example/x",
      `https://fcm.googleapis.com/${"a".repeat(1024)}`,
      "not a url",
    ]) {
      expect(() => subscriptionOf(sub(endpoint)), endpoint).toThrow(new ValidationError("That isn't a browser push subscription."));
    }
  });

  it("refuses keys that can't be a P-256 public key and a 16-byte secret", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    for (const keys of [
      { p256dh: Buffer.alloc(64, 4).toString("base64url"), auth },
      { p256dh: Buffer.alloc(65, 3).toString("base64url"), auth },
      { p256dh, auth: Buffer.alloc(15).toString("base64url") },
      { p256dh: `${p256dh}!`, auth },
      { p256dh },
    ]) {
      expect(() => subscriptionOf({ endpoint, keys })).toThrow(ValidationError);
    }
    expect(() => subscriptionOf(null)).toThrow(ValidationError);
  });
});

describe("subscriptionId", () => {
  it("is the first 32 hex chars of the endpoint's sha256, the same id the browser computes", () => {
    expect(subscriptionId("https://fcm.googleapis.com/fcm/send/abc")).toBe("4e9bdab8bbe7189c00aebb0922fc49fe");
  });
});
