import { describe, it, expect } from "vitest";
import { clearedCookies, ID_COOKIE, REFRESH_COOKIE, sessionCookies } from "./cookies";

describe("session cookies", () => {
  const tokens = { idToken: "id.jwt.x", refreshToken: "refresh-x", expiresIn: 3600 };

  it("cl_id: httpOnly, SameSite=Lax, whole site, lives as long as the token", () => {
    expect(ID_COOKIE).toBe("cl_id");
    expect(sessionCookies(tokens, false)[0]).toEqual({
      name: "cl_id", value: "id.jwt.x",
      options: { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 3600 },
    });
  });

  it("cl_refresh: httpOnly, only sent to /bff/auth, 30 days", () => {
    expect(REFRESH_COOKIE).toBe("cl_refresh");
    expect(sessionCookies(tokens, false)[1]).toEqual({
      name: "cl_refresh", value: "refresh-x",
      options: { httpOnly: true, secure: false, sameSite: "lax", path: "/bff/auth", maxAge: 30 * 24 * 3600 },
    });
  });

  it("Secure only when asked (https on AWS, plain http locally)", () => {
    expect(sessionCookies(tokens, true).every((c) => c.options.secure)).toBe(true);
    expect(sessionCookies(tokens, false).some((c) => c.options.secure)).toBe(false);
  });

  it("a refresh (no new refresh token) only rewrites cl_id", () => {
    expect(sessionCookies({ idToken: "a", expiresIn: 60 }, false).map((c) => c.name)).toEqual([ID_COOKIE]);
  });

  it("sign-out expires both cookies on the paths they were set on", () => {
    expect(clearedCookies(true).map((x) => [x.name, x.value, x.options.path, x.options.maxAge])).toEqual([
      [ID_COOKIE, "", "/", 0], [REFRESH_COOKIE, "", "/bff/auth", 0],
    ]);
  });
});
