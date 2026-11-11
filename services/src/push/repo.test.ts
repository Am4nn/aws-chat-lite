import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { subscriptionId } from "./endpoints.js";
import { pushRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const keys = { p256dh: "p", auth: "a" };
const stored = (n: number) => ({
  pk: "USER#u1", sk: `PUSH#s${n}`, id: `s${n}`, userId: "u1", endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys,
  createdAt: `2026-11-11T10:00:${String(n).padStart(2, "0")}.000Z`,
});

/** A table holding `items` under every user, recording writes. */
function fakeTable(items: object[]) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => (c instanceof QueryCommand ? { Items: items } : {})) as never);
}

describe("pushRepo", () => {
  it("saves a device under its endpoint's id", async () => {
    const send = fakeTable([]);
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    expect(await pushRepo().save("u1", { endpoint, keys })).toEqual({ id: subscriptionId(endpoint) });
    const put = send.mock.calls.map(([c]) => c).find((c) => c instanceof PutCommand) as PutCommand;
    expect(put.input.Item).toMatchObject({ pk: "USER#u1", sk: `PUSH#${subscriptionId(endpoint)}`, userId: "u1", endpoint, keys });
  });

  it("takes a browser over from the user who had it, so their pushes stop reaching it", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/shared";
    const id = subscriptionId(endpoint);
    const send = vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
      if (c instanceof QueryCommand) return { Items: [] };
      if (c instanceof PutCommand && c.input.Item?.pk === `PUSHENDPOINT#${id}`) return { Attributes: { userId: "u2" } };
      return {};
    }) as never);
    await pushRepo().save("u1", { endpoint, keys });
    const deleted = send.mock.calls.map(([c]) => c).filter((c) => c instanceof DeleteCommand) as DeleteCommand[];
    expect(deleted.map((d) => d.input.Key)).toEqual([{ pk: "USER#u2", sk: `PUSH#${id}` }]);
  });

  it("keeps a user's 10 newest devices", async () => {
    const send = fakeTable([3, 1, 11, 2, 4, 5, 6, 7, 8, 9, 10, 12].map(stored));
    await pushRepo().save("u1", { endpoint: "https://fcm.googleapis.com/fcm/send/12", keys });
    const deleted = send.mock.calls.map(([c]) => c).filter((c) => c instanceof DeleteCommand) as DeleteCommand[];
    expect(deleted.map((d) => d.input.Key)).toEqual([{ pk: "USER#u1", sk: "PUSH#s1" }, { pk: "USER#u1", sk: "PUSH#s2" }]);
  });

  it("lists subscriptions without their table keys", async () => {
    fakeTable([stored(1)]);
    const { pk, sk, ...sub } = stored(1);
    expect(await pushRepo().forUsers(["u1"])).toEqual([sub]);
  });
});
