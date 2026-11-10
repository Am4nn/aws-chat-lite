import { describe, it, expect } from "vitest";
import { isFresh, jwtClaims } from "./jwt";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

describe("jwt helpers (decode only; the API's JWT authorizer verifies signatures)", () => {
  it("reads sub and exp", () => {
    expect(jwtClaims(token({ sub: "u1", exp: 100 }))).toEqual({ sub: "u1", exp: 100 });
  });
  it("returns null for garbage", () => {
    expect(jwtClaims("nope")).toBeNull();
    expect(jwtClaims("a.%%%.c")).toBeNull();
  });
  it("is fresh only if it expires more than a minute from now", () => {
    const now = 1_000_000_000_000;
    expect(isFresh(token({ exp: now / 1000 + 3600 }), now)).toBe(true);
    expect(isFresh(token({ exp: now / 1000 + 30 }), now)).toBe(false);
    expect(isFresh(token({ sub: "no-exp" }), now)).toBe(false);
    expect(isFresh(undefined, now)).toBe(false);
  });
});
