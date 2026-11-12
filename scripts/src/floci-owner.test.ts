import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { assertOurFlociUp } from "./floci-owner.js";

const up = (async () => new Response("{}")) as unknown as typeof fetch;

describe("assertOurFlociUp (never deploy into another project's Floci)", () => {
  it("refuses when another project's Floci holds 4566", async () => {
    await expect(assertOurFlociUp("floci\t0.0.0.0:4566->4566/tcp", up)).rejects.toThrow(/held by container floci/);
  });
  it("refuses when chat-lite's Floci isn't running", async () => {
    await expect(assertOurFlociUp("", up)).rejects.toThrow(/npm run floci:up/);
  });
  it("passes when floci-chat holds the port and answers", async () => {
    await expect(assertOurFlociUp("floci-chat\t0.0.0.0:4566->4566/tcp", up)).resolves.toBeUndefined();
  });
  it("is the only way a command checks Floci, so none can reach another project's", () => {
    const dir = new URL("./", import.meta.url);
    const bare = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "env.ts" && f !== "floci-owner.ts")
      .filter((f) => /\bassertFlociUp\(/.test(readFileSync(new URL(f, dir), "utf8")));
    expect(bare).toEqual([]);
  });
});
