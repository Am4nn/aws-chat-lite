import { describe, expect, it, vi } from "vitest";
import { pushKeys } from "./keys.js";

describe("pushKeys", () => {
  it("reads the VAPID keys and subject from the secret", async () => {
    const read = vi.fn(async () => JSON.stringify({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:a@b.c" }));
    expect(await pushKeys({ PUSH_KEYS_SECRET: "cl-local-push-keys" }, read))
      .toEqual({ publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" });
    expect(read).toHaveBeenCalledWith("cl-local-push-keys");
  });

  it("a secret not set yet means push is off, and setting it later takes effect without a cold start", async () => {
    const read = vi.fn().mockResolvedValueOnce('{"unset":"x"}')
      .mockResolvedValue(JSON.stringify({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:a@b.c" }));
    const env = { PUSH_KEYS_SECRET: "cl-local-push-keys-unset" };
    expect(await pushKeys(env, read)).toEqual({});
    expect((await pushKeys(env, read)).publicKey).toBe("pub");
  });

  it("never reads keys from the environment: with no secret, push is off", async () => {
    const read = vi.fn();
    expect(await pushKeys({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }, read)).toEqual({});
    expect(read).not.toHaveBeenCalled();
  });
});
