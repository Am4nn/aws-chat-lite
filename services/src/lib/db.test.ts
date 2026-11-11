import { describe, it, expect, vi, afterEach } from "vitest";
import { BatchGetCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Gone, Unavailable } from "./errors.js";
import { batchGet, docClient, queryAll, takeOnce, transactionConflict } from "./db.js";

process.env.TABLE_NAME = "t";
process.env.AWS_REGION = "us-east-1";

afterEach(() => vi.restoreAllMocks());

describe("queryAll", () => {
  it("follows LastEvaluatedKey until the last page", async () => {
    const pages = [{ Items: [{ n: 1 }], LastEvaluatedKey: { k: 1 } }, { Items: [{ n: 2 }] }];
    const send = vi.spyOn(docClient(), "send").mockImplementation((async () => pages.shift()) as never);
    expect(await queryAll({ KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "x" } })).toEqual([{ n: 1 }, { n: 2 }]);
    const inputs = send.mock.calls.map(([c]) => (c as QueryCommand).input);
    expect(inputs.map((i) => [i.TableName, i.ExclusiveStartKey])).toEqual([["t", undefined], ["t", { k: 1 }]]);
  });
});

describe("batchGet", () => {
  it("retries unprocessed keys", async () => {
    const pages = [
      { Responses: { t: [{ n: 1 }] }, UnprocessedKeys: { t: { Keys: [{ pk: "b", sk: "s" }] } } },
      { Responses: { t: [{ n: 2 }] } },
    ];
    vi.spyOn(docClient(), "send").mockImplementation((async () => pages.shift()) as never);
    expect(await batchGet([{ pk: "a", sk: "s" }, { pk: "b", sk: "s" }])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("gives up after 5 attempts instead of spinning on a throttled table, as a busy (503) error", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.spyOn(docClient(), "send").mockImplementation((async () =>
        ({ Responses: { t: [] }, UnprocessedKeys: { t: { Keys: [{ pk: "a", sk: "s" }] } } })) as never);
      const result = batchGet([{ pk: "a", sk: "s" }]);
      const settled = expect(result).rejects.toBeInstanceOf(Unavailable);
      await vi.runAllTimersAsync();
      await settled;
      expect(send.mock.calls.filter(([c]) => c instanceof BatchGetCommand)).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("transactionConflict", () => {
  it("is true only when a transaction was cancelled because another one was writing the same item", () => {
    const cancelled = (...codes: string[]) => ({ name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });
    expect(transactionConflict(cancelled("None", "TransactionConflict"))).toBe(true);
    expect(transactionConflict(cancelled("None", "ConditionalCheckFailed"))).toBe(false);
    expect(transactionConflict(new Error("boom"))).toBe(false);
  });
});

describe("takeOnce", () => {
  it("deletes the item as it reads it, only while it exists and hasn't expired", async () => {
    const send = vi.spyOn(docClient(), "send").mockImplementation((async () => ({ Attributes: { pk: "F#s", roomId: "r" } })) as never);
    expect(await takeOnce({ pk: "F#s", sk: "META" }, new Gone("expired"))).toEqual({ pk: "F#s", roomId: "r" });
    const { input } = send.mock.calls[0]![0] as DeleteCommand;
    expect(input).toMatchObject({
      TableName: "t", Key: { pk: "F#s", sk: "META" }, ReturnValues: "ALL_OLD",
      ConditionExpression: "attribute_exists(pk) AND #ttl > :now", ExpressionAttributeNames: { "#ttl": "ttl" },
    });
    expect(Number(input.ExpressionAttributeValues![":now"])).toBeCloseTo(Date.now() / 1000, -1);
  });

  it("throws the given error when it is gone", async () => {
    vi.spyOn(docClient(), "send").mockRejectedValue(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }) as never);
    await expect(takeOnce({ pk: "F#s", sk: "META" }, new Gone("expired"))).rejects.toThrow(new Gone("expired"));
  });
});
