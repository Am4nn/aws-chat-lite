import { describe, it, expect, vi, afterEach } from "vitest";
import { BatchGetCommand, DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { Conflict, Forbidden, Gone, NotFound, ValidationError } from "../lib/errors.js";
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

describe("setChatPrefs", () => {
  it("mutes only a people chat: a thread's chat counter has a kind, so the condition refuses it", async () => {
    const send = fakeTable((c) => (c instanceof GetCommand ? { Item: { role: "member" } } : {}));
    await roomsRepo().setChatPrefs("r1", "u1", "c1", true);
    const [check] = transactions(send)[0].input.TransactItems!;
    expect(check.ConditionCheck).toMatchObject({ Key: { pk: "CHAT#c1", sk: "META" }, ConditionExpression: "roomId = :r AND attribute_not_exists(#kind)",
      ExpressionAttributeNames: { "#kind": "kind" },
    });
  });
});

describe("removeMember", () => {
  it("also deletes the removed member's socket subscriptions to the room, as leaving does", async () => {
    const send = fakeTable((c) => {
      if (c instanceof GetCommand) return { Item: { role: c.input.Key?.sk === "MEMBER#u1" ? "owner" : "member" } };
      if (c instanceof QueryCommand) return { Items: [{ pk: "ROOM#r1", sk: "CONN#s1", userId: "u2" }] };
      return {};
    });
    await roomsRepo().removeMember("r1", "u1", "u2");
    const query = send.mock.calls.map(([c]) => c).find((c) => c instanceof QueryCommand) as QueryCommand;
    expect(query.input).toMatchObject({ FilterExpression: "userId = :u", ExpressionAttributeValues: { ":p": "ROOM#r1", ":c": "CONN#", ":u": "u2" } });
    const deleted = send.mock.calls.map(([c]) => c).filter((c) => c instanceof DeleteCommand).map((c) => (c as DeleteCommand).input.Key);
    expect(deleted).toEqual([{ pk: "ROOM#r1", sk: "MEMBER#u2" }, { pk: "ROOM#r1", sk: "CONN#s1" }]);
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

describe("getRoomView", () => {
  const view = (meta: Record<string, unknown>, counters: Record<string, unknown>[] = []) => {
    fakeTable((c) => {
      if (c instanceof GetCommand) return { Item: { name: "Room", ownerId: "u1", ...meta } };
      if (c instanceof BatchGetCommand) return { Responses: { t: c.input.RequestItems!.t!.Keys!.some((k) => String(k.pk).startsWith("CHAT#")) ? counters : [] } };
      if (c instanceof QueryCommand) {
        if (c.input.ExpressionAttributeValues?.[":s"] === "CHAT#") return { Items: [{ chatId: "c1", name: "general" }, { chatId: "c2", name: "old" }] };
        const prefix = c.input.ExpressionAttributeValues?.[":s"] ?? c.input.ExpressionAttributeValues?.[":m"] ?? c.input.ExpressionAttributeValues?.[":a"];
        if (prefix === "MEMBER#") return { Items: [{ userId: "u1", username: "aman", role: "owner" }] };
        if (prefix === "AGENT#") return { Items: [{ pk: "ROOM#r1", sk: "AGENT#a1", agentId: "a1", name: "scout", builtIn: false }] };
      }
      return {};
    });
    return roomsRepo().getRoomView("r1", "u1");
  };

  it("has the room's agents, the built-in first, and its time zone, Asia/Kolkata until an admin sets one", async () => {
    const { agents, timeZone } = await view({});
    expect(agents.map((a) => a.agentId)).toEqual(["agent", "a1"]);
    expect(timeZone).toBe("Asia/Kolkata");
    expect((await view({ timeZone: "Europe/London" })).timeZone).toBe("Europe/London");
  });

  it("marks archived chats and keeps them in the list, which the sidebar sorts out", async () => {
    const { chats } = await view({}, [{ pk: "CHAT#c1", lastSeq: 3, roomId: "r1" }, { pk: "CHAT#c2", lastSeq: 1, roomId: "r1", archived: true }]);
    expect(chats.map((c) => [c.name, c.lastSeq, c.archived])).toEqual([["general", 3, false], ["old", 1, true]]);
  });
});

describe("chat management", () => {
  const chats = [{ pk: "ROOM#r1", sk: "CHAT#2026-01-01#c1", chatId: "c1", name: "general" }, { pk: "ROOM#r1", sk: "CHAT#2026-02-01#c2", chatId: "c2", name: "random" }];
  /** A room whose oldest chat is c1; the caller has `role`; `write` answers (or throws for) every write. */
  const room = (role: string, write: (c: unknown) => unknown = () => ({})) => fakeTable((c) => {
    if (c instanceof GetCommand) return { Item: { role } };
    if (c instanceof QueryCommand) return { Items: c.input.Limit === 1 ? chats.slice(0, 1) : chats };
    return write(c);
  });
  const writes = (send: ReturnType<typeof fakeTable>) => send.mock.calls.map(([c]) => c).filter((c) => !(c instanceof GetCommand || c instanceof QueryCommand));
  const failedAt = (index: number) => Object.assign(new Error("no"), {
    name: "TransactionCanceledException", CancellationReasons: [0, 1, 2].map((i) => ({ Code: i === index ? "ConditionalCheckFailed" : "None" })),
  });

  it("a rename moves the name guard and the chat's name in one transaction, under the chat-name rules", async () => {
    const send = room("admin");
    expect(await roomsRepo().renameChat("r1", "u1", "c2", " Off-Topic ")).toEqual({ chatId: "c2", name: "off-topic" });
    const [move] = writes(send) as TransactWriteCommand[];
    const [drop, claim, rename] = move!.input.TransactItems!;
    expect(drop!.Delete).toMatchObject({ Key: { pk: "ROOM#r1", sk: "CHATNAME#random" }, ConditionExpression: "chatId = :c" });
    expect(claim!.Put).toMatchObject({ Item: { pk: "ROOM#r1", sk: "CHATNAME#off-topic", chatId: "c2" }, ConditionExpression: "attribute_not_exists(pk)" });
    expect(rename!.Update).toMatchObject({ Key: { pk: "ROOM#r1", sk: "CHAT#2026-02-01#c2" }, ConditionExpression: "#name = :old" });
    await expect(roomsRepo().renameChat("r1", "u1", "c2", "no spaces")).rejects.toBeInstanceOf(ValidationError);
  });

  it("the room's first chat may be renamed too", async () => {
    room("owner");
    expect(await roomsRepo().renameChat("r1", "u1", "c1", "lobby")).toEqual({ chatId: "c1", name: "lobby" });
  });

  it("a name another chat or thread holds is refused", async () => {
    room("admin", () => { throw failedAt(1); });
    await expect(roomsRepo().renameChat("r1", "u1", "c2", "general")).rejects.toEqual(new Conflict("#general already exists."));
  });

  it("only admins and the owner manage chats, and not in an archived room", async () => {
    room("member");
    await expect(roomsRepo().renameChat("r1", "u1", "c2", "x")).rejects.toBeInstanceOf(Forbidden);
    await expect(roomsRepo().setChatArchived("r1", "u1", "c2", true)).rejects.toBeInstanceOf(Forbidden);
    fakeTable((c) => (c instanceof GetCommand ? { Item: { role: "owner", archived: true } } : {}));
    await expect(roomsRepo().setChatArchived("r1", "u1", "c2", true)).rejects.toBeInstanceOf(Gone);
  });

  it("a chat that isn't one of the room's is NotFound", async () => {
    room("admin", () => { throw Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" }); });
    await expect(roomsRepo().renameChat("r1", "u1", "c9", "x")).rejects.toBeInstanceOf(NotFound);
    await expect(roomsRepo().setChatArchived("r1", "u1", "c9", true)).rejects.toBeInstanceOf(NotFound);
  });

  it("archiving flags the chat's counter, which every write reads, and only for a people chat", async () => {
    const send = room("admin");
    expect(await roomsRepo().setChatArchived("r1", "u1", "c2", true)).toEqual({ chatId: "c2", archived: true });
    expect(await roomsRepo().setChatArchived("r1", "u1", "c2", false)).toEqual({ chatId: "c2", archived: false });
    const [on, off] = writes(send) as UpdateCommand[];
    expect(on!.input).toMatchObject({
      Key: { pk: "CHAT#c2", sk: "META" }, UpdateExpression: "SET archived = :t",
      ConditionExpression: "roomId = :r AND attribute_not_exists(#kind)",
    });
    expect(off!.input.UpdateExpression).toBe("REMOVE archived");
  });

  it("the room's first chat, its default, can't be archived", async () => {
    const send = room("owner");
    await expect(roomsRepo().setChatArchived("r1", "u1", "c1", true)).rejects.toEqual(new ValidationError("The room's first chat can't be archived."));
    expect(writes(send)).toEqual([]);
  });

  it("archived must be true or false", async () => {
    room("owner");
    await expect(roomsRepo().setChatArchived("r1", "u1", "c2", "yes")).rejects.toBeInstanceOf(ValidationError);
  });
});
