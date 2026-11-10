import { describe, it, expect, beforeEach } from "vitest";
import { handler } from "./health.js";

describe("GET /health", () => {
  beforeEach(() => { process.env.STAGE = "local"; });

  it("returns 200 JSON with ok and stage", async () => {
    const res = await handler();
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body as string)).toMatchObject({ ok: true, stage: "local" });
  });
});
