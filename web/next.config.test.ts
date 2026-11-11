import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("next.config headers", () => {
  it.each(["/consent", "/apps"])("%s can't be framed", async (path) => {
    const rules = (await config.headers!()).filter((r) => r.source === path);
    const headers = Object.fromEntries(rules.flatMap((r) => r.headers).map((h) => [h.key, h.value]));
    expect(headers["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });
});
