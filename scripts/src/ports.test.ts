import { describe, it, expect } from "vitest";
import { portOwner, assertPortFree } from "./ports.js";

describe("portOwner", () => {
  it("finds the container publishing the port", () => {
    const ps = "floci\t0.0.0.0:4566->4566/tcp, [::]:4566->4566/tcp\nweb\t0.0.0.0:3000->3000/tcp";
    expect(portOwner(ps, 4566)).toBe("floci");
    expect(portOwner(ps, 4567)).toBeUndefined();
  });
});

describe("assertPortFree", () => {
  it("throws naming the other container", () => {
    expect(() => assertPortFree(4566, "floci-chat", "floci\t0.0.0.0:4566->4566/tcp")).toThrow(/held by container floci/);
  });
  it("passes for our own container or a free port", () => {
    expect(() => assertPortFree(4566, "floci-chat", "floci-chat\t0.0.0.0:4566->4566/tcp")).not.toThrow();
    expect(() => assertPortFree(4566, "floci-chat", "")).not.toThrow();
  });
});
