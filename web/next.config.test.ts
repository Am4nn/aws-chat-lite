import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("next.config headers", () => {
  // A framed /consent sends a signed-out visitor on to /login, so every page needs the headers, not only /consent and /apps.
  it("no page can be framed", async () => {
    const rules = (await config.headers!()).filter((r) => r.source === "/:path*");
    const headers = Object.fromEntries(rules.flatMap((r) => r.headers).map((h) => [h.key, h.value]));
    expect(headers["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });
});
