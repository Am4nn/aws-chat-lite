import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test gets a fresh module, so the per-container cache starts empty.
let secretJson: typeof import("./secrets.js").secretJson;
beforeEach(async () => {
  vi.resetModules();
  ({ secretJson } = await import("./secrets.js"));
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

  it("never echoes a secret that isn't JSON", async () => {
    const error = await secretJson("cl-aws-model-keys", async () => "sk-not-json-at-all").catch((e) => e);
    expect(error).toEqual(new Error("The secret cl-aws-model-keys isn't valid JSON."));
    expect(String(error.stack)).not.toContain("sk-not");
  });
});
