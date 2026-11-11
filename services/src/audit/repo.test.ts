import { afterEach, describe, expect, it, vi } from "vitest";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { auditRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const fakeTable = (reply: (c: unknown) => unknown) =>
  vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => reply(c)) as never);
const entry = { at: "2026-11-11T10:00:00.000Z", actor: "aman", kind: "tool" as const, detail: "Commented on #1" };

describe("record", () => {
  it("appends under the room, newest last by key, never over an existing entry", async () => {
    const send = fakeTable(() => ({}));
    expect(await auditRepo().record("r1", { ...entry, id: "run1#7" })).toEqual({ ...entry, id: "run1#7" });
    const put = send.mock.calls[0][0] as PutCommand;
    expect(put.input).toMatchObject({
      Item: { pk: "ROOM#r1", sk: "AUDIT#2026-11-11T10:00:00.000Z#run1#7", ...entry },
      ConditionExpression: "attribute_not_exists(sk)",
    });
  });

  it("treats a repeat of the same entry as done", async () => {
    fakeTable(() => {
      throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
    });
    await expect(auditRepo().record("r1", { ...entry, id: "run1#7" })).resolves.toMatchObject({ id: "run1#7" });
  });

  it("gives an entry without an id a fresh one", async () => {
    fakeTable(() => ({}));
    expect((await auditRepo().record("r1", entry)).id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("list", () => {
  it("reads 50 newest first and hands back a cursor to the older ones", async () => {
    const send = fakeTable(() => ({
      Items: [{ pk: "ROOM#r1", sk: "AUDIT#a#1", ...entry, id: "1" }],
      LastEvaluatedKey: { pk: "ROOM#r1", sk: "AUDIT#a#1" },
    }));
    expect(await auditRepo().list("r1", "b#2")).toEqual({ entries: [{ ...entry, id: "1" }], next: "a#1" });
    expect((send.mock.calls[0][0] as QueryCommand).input).toMatchObject({
      ExpressionAttributeValues: { ":pk": "ROOM#r1", ":audit": "AUDIT#" },
      ScanIndexForward: false,
      Limit: 50,
      ExclusiveStartKey: { pk: "ROOM#r1", sk: "AUDIT#b#2" },
    });
  });
});
