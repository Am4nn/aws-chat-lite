import { describe, it, expect } from "vitest";
import { expiresIn, inviteUrl } from "./invite";

describe("inviteUrl", () => {
  it("is the site origin plus /invite/<code>", () => {
    expect(inviteUrl("https://chat.example.com", "AbC_12-x")).toBe("https://chat.example.com/invite/AbC_12-x");
  });
});

describe("expiresIn (how long a link still works, in words)", () => {
  const now = 1_800_000_000;
  it("days when a day or more is left", () => {
    expect(expiresIn(now + 6 * 86400 + 100, now)).toBe("6 days");
    expect(expiresIn(now + 86400, now)).toBe("1 day");
  });
  it("hours, then minutes, as it gets close", () => {
    expect(expiresIn(now + 23 * 3600, now)).toBe("23 hours");
    expect(expiresIn(now + 3600, now)).toBe("1 hour");
    expect(expiresIn(now + 59 * 60, now)).toBe("59 minutes");
    expect(expiresIn(now + 30, now)).toBe("1 minute");
  });
  it("expired at or past the deadline", () => {
    expect(expiresIn(now, now)).toBe("expired");
    expect(expiresIn(now - 10, now)).toBe("expired");
  });
});
