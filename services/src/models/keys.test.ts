import { describe, expect, it, vi } from "vitest";
import { deepseekBaseUrl, modelKeys } from "./keys.js";

describe("deepseekBaseUrl", () => {
  it("points any form of DeepSeek's base URL at its Anthropic-compatible endpoint", () => {
    for (const base of [
      "https://api.deepseek.com",
      "https://api.deepseek.com/",
      "https://api.deepseek.com/v1",
      "https://api.deepseek.com/anthropic",
    ]) {
      expect(deepseekBaseUrl(base)).toBe("https://api.deepseek.com/anthropic");
    }
  });
});

describe("modelKeys", () => {
  it("reads the keys from the environment when there is no secret", async () => {
    const env = { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d", DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1" };
    expect(await modelKeys(env, vi.fn())).toEqual({
      anthropicKey: "a",
      deepseekKey: "d",
      deepseekBaseUrl: "https://api.deepseek.com/anthropic",
    });
  });

  it("reads the secret once per container", async () => {
    const read = vi.fn(async () => ({ ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" }));
    const env = { MODEL_KEYS_SECRET: "cl-local-model-keys", ANTHROPIC_API_KEY: "ignored" };
    expect(await modelKeys(env, read)).toEqual({ anthropicKey: "a", deepseekKey: "d", deepseekBaseUrl: undefined });
    await modelKeys(env, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("cl-local-model-keys");
  });

  it("reads the secret again after a failed read", async () => {
    vi.resetModules();
    const fresh = await import("./keys.js");
    const read = vi.fn().mockRejectedValueOnce(new Error("throttled")).mockResolvedValue({ ANTHROPIC_API_KEY: "a" });
    const env = { MODEL_KEYS_SECRET: "cl-local-model-keys" };
    await expect(fresh.modelKeys(env, read)).rejects.toThrow("throttled");
    expect(await fresh.modelKeys(env, read)).toMatchObject({ anthropicKey: "a" });
  });
});
