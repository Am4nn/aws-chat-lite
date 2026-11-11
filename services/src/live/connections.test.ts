import { describe, it, expect, vi, afterEach } from "vitest";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { subscribe } from "./connections.js";

process.env.TABLE_NAME = "t";
process.env.AWS_REGION = "us-east-1";

afterEach(() => vi.restoreAllMocks());

describe("subscribe", () => {
  it("adds the room to the live connection item, then writes the room's subscription", async () => {
    const send = vi.spyOn(docClient(), "send").mockImplementation((async () => ({})) as never);
    await subscribe("c1", "u1", "r1");
    const [update, put] = send.mock.calls.map(([c]) => c);
    expect(update).toBeInstanceOf(UpdateCommand);
    expect((update as UpdateCommand).input).toMatchObject({
      Key: { pk: "CONN#c1", sk: "META" }, UpdateExpression: "ADD roomIds :r", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":r": new Set(["r1"]) },
    });
    expect(put).toBeInstanceOf(PutCommand);
    expect((put as PutCommand).input.Item).toMatchObject({ pk: "ROOM#r1", sk: "CONN#c1", userId: "u1" });
  });

  it("writes nothing more once the socket's connection item is gone, so a late subscribe can't revive it", async () => {
    const send = vi.spyOn(docClient(), "send").mockImplementation((async () => {
      throw Object.assign(new Error("gone"), { name: "ConditionalCheckFailedException" });
    }) as never);
    await subscribe("c1", "u1", "r1");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
