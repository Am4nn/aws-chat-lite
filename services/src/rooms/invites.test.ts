import { describe, it, expect } from "vitest";
import { newInviteCode, inviteState, INVITE_TTL_SEC } from "./invites.js";

describe("newInviteCode", () => {
  it("is 22 url-safe characters (128 random bits)", () => {
    expect(newInviteCode()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it("does not repeat", () => {
    const codes = new Set(Array.from({ length: 1000 }, newInviteCode));
    expect(codes.size).toBe(1000);
  });
});

describe("inviteState", () => {
  const now = 1_800_000_000;
  it("ok before expiry", () => expect(inviteState({ expiresAt: now + 1 }, now)).toBe("ok"));
  it("expired at or after expiresAt", () => {
    expect(inviteState({ expiresAt: now }, now)).toBe("expired");
    expect(inviteState({ expiresAt: now - 5 }, now)).toBe("expired");
  });
  it("revoked wins even before expiry", () => expect(inviteState({ expiresAt: now + 999, revoked: true }, now)).toBe("revoked"));
  it("missing when there is no invite", () => expect(inviteState(undefined, now)).toBe("missing"));
  it("lasts 7 days", () => expect(INVITE_TTL_SEC).toBe(7 * 24 * 3600));
});
