import { describe, it, expect } from "vitest";
import { safeNext } from "./next-path";

describe("safeNext (where to go after login or a token refresh)", () => {
  it("keeps same-site paths with their query", () => {
    expect(safeNext("/r/abc")).toBe("/r/abc");
    expect(safeNext("/invite/xyz?ref=1")).toBe("/invite/xyz?ref=1");
  });
  it("falls back to / for anything that could leave the site", () => {
    for (const bad of [null, "", "//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "rooms", "/\t/evil.com", "/\n/evil.com", "/\r/evil.com"]) {
      expect(safeNext(bad), String(bad)).toBe("/");
    }
  });
  it("never loops back into the auth endpoints", () => {
    expect(safeNext("/bff/auth/refresh?next=/")).toBe("/");
    expect(safeNext("/login")).toBe("/");
  });
});
