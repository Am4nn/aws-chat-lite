import { describe, it, expect } from "vitest";
import { isOnline } from "./presence.js";

const now = 1_800_000_000;

describe("isOnline", () => {
  it("an open socket that pinged a minute ago is online", () => {
    expect(isOnline({ conns: 1, lastPing: now - 60 }, now)).toBe(true);
  });
  it("no ping for over 11 minutes is offline, even with a socket counted (one that died without $disconnect)", () => {
    expect(isOnline({ conns: 1, lastPing: now - 700 }, now)).toBe(false);
  });
  it("no open sockets is offline", () => {
    expect(isOnline({ conns: 0, lastPing: now }, now)).toBe(false);
  });
  it("never connected is offline", () => {
    expect(isOnline(undefined, now)).toBe(false);
  });
});
