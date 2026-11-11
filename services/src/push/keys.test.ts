import { describe, expect, it, vi } from "vitest";
import { pushKeys } from "./keys.js";

describe("pushKeys", () => {
  it("reads the VAPID keys and subject from the secret", async () => {
    const read = vi.fn(async () => JSON.stringify({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:a@b.c" }));
    expect(await pushKeys({ PUSH_KEYS_SECRET: "cl-local-push-keys" }, read))
      .toEqual({ publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" });
    expect(read).toHaveBeenCalledWith("cl-local-push-keys");
  });

  it("never reads keys from the environment: with no secret, push is off", async () => {
    const read = vi.fn();
    expect(await pushKeys({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }, read)).toEqual({});
    expect(read).not.toHaveBeenCalled();
  });
});
