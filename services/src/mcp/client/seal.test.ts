import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { seal, SealError, tokenKey, unseal } from "./seal.js";

describe("seal", () => {
  const key = randomBytes(32);

  it("opens what it sealed, only with the same key and aad", () => {
    const sealed = seal(key, "access token text", "room1#test");
    expect(sealed).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/);
    expect(sealed).not.toContain("access");
    expect(unseal(key, sealed, "room1#test")).toBe("access token text");
    expect(() => unseal(key, sealed, "room2#test")).toThrow(SealError);
    expect(() => unseal(randomBytes(32), sealed, "room1#test")).toThrow(SealError);
  });

  it("refuses a flipped byte and a blob that isn't one", () => {
    const sealed = seal(key, "hello", "a");
    const data = Buffer.from(sealed.split(".")[2]!, "base64url");
    data[0]! ^= 1;
    const flipped = sealed.split(".").slice(0, 2).concat(data.toString("base64url")).join(".");
    expect(() => unseal(key, flipped, "a")).toThrow(SealError);
    expect(() => unseal(key, "v1.abc", "a")).toThrow(SealError);
    expect(() => unseal(key, "v1.AAAAAAAAAAAAAAAA.AAAA", "a")).toThrow(SealError);
  });

  it("uses a fresh IV every time", () => {
    expect(seal(key, "x", "a")).not.toBe(seal(key, "x", "a"));
  });
});

describe("tokenKey", () => {
  it("reads the secret once and derives 32 bytes", async () => {
    const read = vi.fn(async () => "generated-secret-text");
    const env = { TOKEN_KEY_SECRET: "cl-local-token-key" };
    const first = await tokenKey(env, read);
    const second = await tokenKey(env, read);
    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    expect(read.mock.calls).toEqual([["cl-local-token-key"]]);
  });
});
