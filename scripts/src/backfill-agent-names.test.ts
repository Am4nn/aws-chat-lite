import { describe, expect, it, vi } from "vitest";
import { ListUsersCommand, type CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { PutCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backfillAgentCounts, backfillUsernames } from "./backfill-agent-names.js";

const agent = (roomId: string, agentId: string, name: string, extra = {}) => ({ pk: `ROOM#${roomId}`, sk: `AGENT#${agentId}`, agentId, name, ...extra });
const counted = (name: string, agentCount: number) => ({ pk: `AGENTNAME#${name}`, sk: "META", agentCount });

/** A table scanned in pages, recording what is written; a write whose condition names `raced` fails it. */
function fakeTable(pages: Record<string, unknown>[][], raced?: string) {
  const send = vi.fn(async (c: unknown) => {
    if (c instanceof ScanCommand) {
      const at = Number(c.input.ExclusiveStartKey?.page ?? 0);
      return { Items: pages[at], LastEvaluatedKey: at + 1 < pages.length ? { page: at + 1 } : undefined };
    }
    if (c instanceof PutCommand && c.input.Item?.pk === `AGENTNAME#${raced}`) {
      throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
    }
    return {};
  });
  const puts = () => send.mock.calls.map(([c]) => c).filter((c) => c instanceof PutCommand).map((c) => (c as PutCommand).input);
  return { db: { send } as unknown as DynamoDBDocumentClient, puts };
}

describe("backfillAgentCounts", () => {
  it("counts each name's live agents across rooms, leaving out deleted agents and the built-in, only where no count is yet", async () => {
    const { db, puts } = fakeTable([
      [agent("r1", "a1", "reviewer"), agent("r2", "a2", "reviewer"), { pk: "ROOM#r1", sk: "AGENTNAME#reviewer", agentId: "a1" }],
      [agent("r3", "a3", "reviewer", { deleted: true }), agent("r1", "agent", "agent"), agent("r1", "a4", "scout")],
    ]);
    expect(await backfillAgentCounts(db, "t")).toEqual({
      changed: [{ name: "reviewer", from: 0, to: 2 }, { name: "scout", from: 0, to: 1 }], raced: [],
    });
    expect(puts()).toEqual([
      { TableName: "t", Item: { pk: "AGENTNAME#reviewer", sk: "META", agentCount: 2 }, ConditionExpression: "attribute_not_exists(pk)" },
      { TableName: "t", Item: { pk: "AGENTNAME#scout", sk: "META", agentCount: 1 }, ConditionExpression: "attribute_not_exists(pk)" },
    ]);
  });

  it("corrects a wrong count only if it still holds what was read, sets a stale one to 0 and leaves a right one alone", async () => {
    const { db, puts } = fakeTable([[agent("r1", "a1", "reviewer"), counted("reviewer", 3), counted("gone", 1), counted("scout", 1), agent("r1", "a2", "scout")]]);
    expect(await backfillAgentCounts(db, "t")).toEqual({
      changed: [{ name: "reviewer", from: 3, to: 1 }, { name: "gone", from: 1, to: 0 }], raced: [],
    });
    expect(puts().map(({ Item, ConditionExpression, ExpressionAttributeValues }) => ({ Item, ConditionExpression, ExpressionAttributeValues }))).toEqual([
      { Item: counted("reviewer", 1), ConditionExpression: "agentCount = :read", ExpressionAttributeValues: { ":read": 3 } },
      { Item: counted("gone", 0), ConditionExpression: "agentCount = :read", ExpressionAttributeValues: { ":read": 1 } },
    ]);
  });

  it("leaves a count an agent changed during the run as it is, and says so", async () => {
    const { db } = fakeTable([[agent("r1", "a1", "reviewer"), agent("r1", "a2", "scout")]], "reviewer");
    expect(await backfillAgentCounts(db, "t")).toEqual({ changed: [{ name: "scout", from: 0, to: 1 }], raced: ["reviewer"] });
  });
});

describe("backfillUsernames", () => {
  it("records every account's name, lowercased, across ListUsers pages", async () => {
    const { db, puts } = fakeTable([]);
    const pages = [{ Users: [{ Username: "Goat" }, { Username: "ann" }], PaginationToken: "p2" }, { Users: [{ Username: "Bob" }] }];
    const send = vi.fn(async (c: ListUsersCommand) => pages[c.input.PaginationToken ? 1 : 0]);
    const cognito = { send } as unknown as CognitoIdentityProviderClient;
    expect(await backfillUsernames(cognito, "pool-1", db, "t")).toBe(3);
    expect(send.mock.calls.map(([c]) => c.input)).toEqual([{ UserPoolId: "pool-1" }, { UserPoolId: "pool-1", PaginationToken: "p2" }]);
    expect(puts()).toEqual(["goat", "ann", "bob"].map((n) => ({ TableName: "t", Item: { pk: `USERNAME#${n}`, sk: "META" } })));
  });
});
