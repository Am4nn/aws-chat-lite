import { describe, it, expect } from "vitest";
import { matchForward } from "./forward";

describe("matchForward (/bff/api/* → HTTP API allowlist)", () => {
  it.each([
    ["GET", ["me"], "/me"],
    ["GET", ["rooms"], "/rooms"],
    ["POST", ["rooms"], "/rooms"],
    ["GET", ["rooms", "r1"], "/rooms/r1"],
    ["POST", ["rooms", "r1", "chats"], "/rooms/r1/chats"],
    ["PATCH", ["rooms", "r1", "members", "u-2"], "/rooms/r1/members/u-2"],
    ["DELETE", ["rooms", "r1", "members", "u-2"], "/rooms/r1/members/u-2"],
    ["POST", ["rooms", "r1", "invite"], "/rooms/r1/invite"],
    ["GET", ["rooms", "r1", "invite"], "/rooms/r1/invite"],
    ["DELETE", ["rooms", "r1", "invite"], "/rooms/r1/invite"],
    ["POST", ["invites", "AbC_12-x", "accept"], "/invites/AbC_12-x/accept"],
    ["POST", ["ws", "ticket"], "/ws/ticket"],
    ["GET", ["rooms", "r1", "chats", "c1", "messages"], "/rooms/r1/chats/c1/messages"],
  ])("%s %j → %s", (method, segs, path) => {
    expect(matchForward(method, segs)).toBe(path);
  });

  it.each([
    ["PUT", ["rooms", "r1"]],
    ["DELETE", ["rooms", "r1"]],
    ["GET", ["..", "health"]],
    ["GET", ["rooms", "a/b"]],
    ["GET", ["rooms", "%2e%2e"]],
    ["GET", ["health"]],
    ["GET", ["ws", "ticket"]],
    ["POST", ["rooms", "r1", "chats", "c1", "messages"]],
    ["GET", []],
  ])("refuses %s %j", (method, segs) => {
    expect(matchForward(method, segs)).toBeNull();
  });
});
