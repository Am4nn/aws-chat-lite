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
    ["POST", ["live", "ticket"], "/live/ticket"],
    ["GET", ["rooms", "r1", "chats", "c1", "messages"], "/rooms/r1/chats/c1/messages"],
    ["POST", ["rooms", "r1", "attachments"], "/rooms/r1/attachments"],
    ["GET", ["rooms", "r1", "search"], "/rooms/r1/search"],
    ["PATCH", ["rooms", "r1", "chats", "c1", "prefs"], "/rooms/r1/chats/c1/prefs"],
    ["POST", ["rooms", "r1", "leave"], "/rooms/r1/leave"],
    ["POST", ["rooms", "r1", "archive"], "/rooms/r1/archive"],
    ["POST", ["runs", "abc", "stream-ticket"], "/runs/abc/stream-ticket"],
    ["PUT", ["rooms", "r", "budget"], "/rooms/r/budget"],
    ["PUT", ["rooms", "r", "model"], "/rooms/r/model"],
    ["PATCH", ["rooms", "r", "threads", "t"], "/rooms/r/threads/t"],
    ["POST", ["rooms", "r", "threads"], "/rooms/r/threads"],
    ["GET", ["rooms", "r", "connections"], "/rooms/r/connections"],
    ["GET", ["rooms", "r", "connections", "github", "installations"], "/rooms/r/connections/github/installations"],
    ["PUT", ["rooms", "r", "connections", "github"], "/rooms/r/connections/github"],
    ["DELETE", ["rooms", "r", "connections", "github"], "/rooms/r/connections/github"],
    ["PUT", ["rooms", "r", "approval-timeout"], "/rooms/r/approval-timeout"],
    ["GET", ["rooms", "r", "audit"], "/rooms/r/audit"],
    ["POST", ["runs", "abc", "approvals", "2"], "/runs/abc/approvals/2"],
    ["GET", ["rooms", "r", "files"], "/rooms/r/files"],
    ["POST", ["rooms", "r", "files", "uploads"], "/rooms/r/files/uploads"],
    ["PUT", ["rooms", "r", "files"], "/rooms/r/files"],
    ["GET", ["rooms", "r", "files", "download"], "/rooms/r/files/download"],
    ["DELETE", ["rooms", "r", "files"], "/rooms/r/files"],
    ["PUT", ["rooms", "r", "sandbox"], "/rooms/r/sandbox"],
    ["GET", ["oauth", "requests", "q1"], "/oauth/requests/q1"],
    ["POST", ["oauth", "requests", "q1", "decision"], "/oauth/requests/q1/decision"],
    ["GET", ["me", "apps"], "/me/apps"],
    ["DELETE", ["me", "apps", "g1"], "/me/apps/g1"],
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
    ["GET", ["live", "ticket"]],
    ["POST", ["ws", "ticket"]],
    ["POST", ["rooms", "r1", "chats", "c1", "messages"]],
    ["GET", ["rooms", "r1", "attachments"]],
    ["POST", ["rooms", "r1", "search"]],
    ["GET", []],
    ["DELETE", ["rooms", "r", "threads", "t"]],
    ["GET", ["runs", "abc", "stream-ticket"]],
    ["DELETE", ["rooms", "r", "connections", "slack"]],
    ["GET", ["runs", "abc", "approvals", "2"]],
    ["DELETE", ["rooms", "r", "files", "x"]],
    ["POST", ["me", "apps"]],
    ["DELETE", ["oauth", "requests", "q1"]],
    ["POST", ["oauth", "token"]],
  ])("refuses %s %j", (method, segs) => {
    expect(matchForward(method, segs)).toBeNull();
  });
});
