import { describe, it, expect, vi, afterEach } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { Conflict } from "../lib/errors.js";
import { roomsRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const invite = { roomId: "r1", roomName: "Room", expiresAt: Math.floor(Date.now() / 1000) + 3600 };

/** Answers each command from `reply`; every call is recorded. */
const fakeTable = (reply: (c: unknown) => unknown) =>
  vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => reply(c)) as never);

const transactions = (send: ReturnType<typeof fakeTable>) =>
  send.mock.calls.map(([c]) => c).filter((c) => c instanceof TransactWriteCommand) as TransactWriteCommand[];

describe("acceptInvite", () => {
  it("counts the join on the room's META, so an archive racing it can tell", async () => {
    const send = fakeTable((c) => (c instanceof GetCommand ? { Item: invite } : {}));
    await roomsRepo().acceptInvite("code", { userId: "u2", username: "bee" });
    const [meta] = transactions(send)[0].input.TransactItems!;
    expect(meta.Update).toMatchObject({
      Key: { pk: "ROOM#r1", sk: "META" }, UpdateExpression: "ADD joinCount :one",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(archived)",
    });
  });

  it("a clash with another transaction asks to try again", async () => {
    fakeTable((c) => {
      if (c instanceof GetCommand) return { Item: invite };
      throw Object.assign(new Error("clash"), {
        name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
      });
    });
    await expect(roomsRepo().acceptInvite("code", { userId: "u2", username: "bee" })).rejects.toBeInstanceOf(Conflict);
  });
});

describe("archiveRoom", () => {
  it("only applies if nobody joined since it read the members", async () => {
    const send = fakeTable((c) => {
      if (c instanceof GetCommand) return { Item: String(c.input.Key?.sk) === "META" ? { joinCount: 4 } : c.input.Key?.sk === "INVITE" ? undefined : { role: "owner" } };
      if (c instanceof QueryCommand) return { Items: [{ sk: "MEMBER#u1" }] };
      return {};
    });
    await roomsRepo().archiveRoom("r1", "u1");
    const [meta] = transactions(send)[0].input.TransactItems!;
    expect(meta.Update?.Key).toEqual({ pk: "ROOM#r1", sk: "META" });
    expect(meta.Update?.ConditionExpression).toContain("(attribute_not_exists(joinCount) OR joinCount = :joins)");
    expect(meta.Update?.ExpressionAttributeValues).toMatchObject({ ":joins": 4 });
  });
});

describe("reads that can span pages", () => {
  it("listMyRooms follows every page of the user's rooms", async () => {
    const pages = [
      { Items: [{ roomId: "a", roomName: "A", role: "owner" }], LastEvaluatedKey: { k: 1 } },
      { Items: [{ roomId: "b", roomName: "B", role: "member" }] },
    ];
    fakeTable(() => pages.shift());
    expect((await roomsRepo().listMyRooms("u1")).map((r) => r.roomId)).toEqual(["a", "b"]);
  });

  it("previewInvite counts members across pages", async () => {
    const pages = [{ Items: [{ sk: "MEMBER#1" }], LastEvaluatedKey: { k: 1 } }, { Items: [{ sk: "MEMBER#2" }, { sk: "MEMBER#3" }] }];
    fakeTable((c) => (c instanceof GetCommand ? { Item: invite } : pages.shift()));
    expect((await roomsRepo().previewInvite("code")).memberCount).toBe(3);
  });
});
