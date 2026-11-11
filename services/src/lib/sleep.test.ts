import { describe, expect, it } from "vitest";
import { sleep } from "./sleep.js";

describe("sleep", () => {
  it("waits", async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it("wakes early when its signal aborts", async () => {
    const stop = new AbortController();
    const t0 = Date.now();
    setTimeout(() => stop.abort(), 10);
    await sleep(5_000, stop.signal);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
