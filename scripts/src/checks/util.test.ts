import { describe, it, expect } from "vitest";
import { withTimeout } from "./util.js";

describe("withTimeout", () => {
  it("rejects after ms", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "ws echo")).rejects.toThrow(/ws echo: no result within 0.02s/);
  });
  it("passes the value through", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });
});
