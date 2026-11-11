import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test gets a fresh module, so the per-container cache starts empty.
let secretJson: typeof import("./secrets.js").secretJson;
let secretText: typeof import("./secrets.js").secretText;
beforeEach(async () => {
  vi.resetModules();
  ({ secretJson, secretText } = await import("./secrets.js"));
});

describe("secretText", () => {
  it("returns the raw text, read once per container, shared with secretJson", async () => {
    const read = vi.fn(async () => "{\"K\":\"v\"}");
    expect(await secretText("a", read)).toBe("{\"K\":\"v\"}");
    expect(await secretJson("a", read)).toEqual({ K: "v" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("refuses a secret with no text", async () => {
    await expect(secretText("a", async () => undefined)).rejects.toThrow("The secret a has no text.");
  });
});

describe("secretJson", () => {
  it("reads each secret once per container", async () => {
    const read = vi.fn(async (name: string) => JSON.stringify({ NAME: name }));
    expect(await secretJson("a", read)).toEqual({ NAME: "a" });
    expect(await secretJson("a", read)).toEqual({ NAME: "a" });
    expect(await secretJson("b", read)).toEqual({ NAME: "b" });
    expect(read.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("reads again after a failed read", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("throttled")).mockResolvedValue('{"K":"v"}');
    await expect(secretJson("a", read)).rejects.toThrow("throttled");
    expect(await secretJson("a", read)).toEqual({ K: "v" });
  });

  it("reads a secret that isn't JSON again next time, so fixing it takes effect on a warm container", async () => {
    const read = vi.fn().mockResolvedValueOnce("a-placeholder").mockResolvedValue('{"K":"v"}');
    await expect(secretJson("a", read)).rejects.toThrow("The secret a isn't valid JSON.");
    expect(await secretJson("a", read)).toEqual({ K: "v" });
  });

  it("reads a secret missing a needed field again next time, and keeps it once it has them all", async () => {
    const read = vi.fn().mockResolvedValueOnce('{"unset":"x"}').mockResolvedValue('{"K":"v"}');
    expect(await secretJson("a", read, ["K"])).toEqual({ unset: "x" });
    expect(await secretJson("a", read, ["K"])).toEqual({ K: "v" });
    expect(await secretJson("a", read, ["K"])).toEqual({ K: "v" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never echoes a secret that isn't JSON", async () => {
    const error = await secretJson("cl-aws-model-keys", async () => "sk-not-json-at-all").catch((e) => e);
    expect(error).toEqual(new Error("The secret cl-aws-model-keys isn't valid JSON."));
    expect(String(error.stack)).not.toContain("sk-not");
  });
});
