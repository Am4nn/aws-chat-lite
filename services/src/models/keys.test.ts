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
    const env = { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d", DEEPSEEK_BASE_URL: "https://example.test/v1" };
    expect(await modelKeys(env, vi.fn())).toEqual({
      anthropicKey: "a",
      deepseekKey: "d",
      deepseekBaseUrl: "https://example.test/anthropic",
    });
  });

  it("defaults DeepSeek to its own Anthropic-compatible endpoint", async () => {
    expect((await modelKeys({ DEEPSEEK_API_KEY: "d" }, vi.fn())).deepseekBaseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  it("reads the secret once per container", async () => {
    const read = vi.fn(async () => JSON.stringify({ ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" }));
    const env = { MODEL_KEYS_SECRET: "cl-local-model-keys", ANTHROPIC_API_KEY: "ignored" };
    expect(await modelKeys(env, read)).toEqual({
      anthropicKey: "a",
      deepseekKey: "d",
      deepseekBaseUrl: "https://api.deepseek.com/anthropic",
    });
    await modelKeys(env, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("cl-local-model-keys");
  });

  it("reads the secret again after a failed read", async () => {
    vi.resetModules();
    const fresh = await import("./keys.js");
    const read = vi.fn().mockRejectedValueOnce(new Error("throttled")).mockResolvedValue('{"ANTHROPIC_API_KEY":"a"}');
    const env = { MODEL_KEYS_SECRET: "cl-local-model-keys" };
    await expect(fresh.modelKeys(env, read)).rejects.toThrow("throttled");
    expect(await fresh.modelKeys(env, read)).toMatchObject({ anthropicKey: "a" });
  });

  it("never echoes a secret that isn't JSON", async () => {
    vi.resetModules();
    const fresh = await import("./keys.js");
    const error = await fresh.modelKeys({ MODEL_KEYS_SECRET: "cl-aws-model-keys" }, async () => "sk-not-json-at-all").catch((e) => e);
    expect(error).toEqual(new Error("The model keys secret isn't valid JSON."));
    expect(String(error.stack)).not.toContain("sk-not");
  });
});
