import { describe, it, expect, vi, afterEach } from "vitest";
import type { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { isOnline, markDisconnected } from "./presence.js";

process.env.TABLE_NAME = "t";
process.env.AWS_REGION = "us-east-1";

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

describe("markDisconnected", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never takes the socket count below zero; a socket already counted off changes nothing", async () => {
    const send = vi.spyOn(docClient(), "send").mockImplementation((async () => {
      throw Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" });
    }) as never);
    expect(await markDisconnected("u1")).toBeUndefined();
    expect((send.mock.calls[0][0] as UpdateCommand).input.ConditionExpression).toBe("conns > :zero");
  });
});
