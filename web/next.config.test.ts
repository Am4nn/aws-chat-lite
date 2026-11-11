import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("next.config headers", () => {
  it("no page can be framed: one rule covers every path", async () => {
    const rules = await config.headers!();
    expect(rules.map((r) => r.source)).toEqual(["/:path*"]);
    const headers = Object.fromEntries(rules[0]!.headers.map((h) => [h.key, h.value]));
    expect(headers["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });
});
