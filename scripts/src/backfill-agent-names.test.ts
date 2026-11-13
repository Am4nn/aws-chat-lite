import { describe, expect, it, vi } from "vitest";
import { PutCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backfillAgentNames } from "./backfill-agent-names.js";

const agent = (roomId: string, agentId: string, name: string, extra = {}) => ({ pk: `ROOM#${roomId}`, sk: `AGENT#${agentId}`, agentId, name, ...extra });
const counted = (name: string, agentCount: number) => ({ pk: `AGENTNAME#${name}`, sk: "META", agentCount });

/** A table scanned in two pages, recording what the backfill writes. */
function fakeTable(pages: Record<string, unknown>[][]) {
  const send = vi.fn(async (c: unknown) => {
    if (c instanceof ScanCommand) {
      const at = Number(c.input.ExclusiveStartKey?.page ?? 0);
      return { Items: pages[at], LastEvaluatedKey: at + 1 < pages.length ? { page: at + 1 } : undefined };
    }
    return {};
  });
  const puts = () => send.mock.calls.map(([c]) => c).filter((c) => c instanceof PutCommand).map((c) => (c as PutCommand).input.Item);
  return { db: { send } as unknown as DynamoDBDocumentClient, puts };
}

describe("backfillAgentNames", () => {
  it("counts each name's live agents across rooms, leaving out deleted agents and the built-in", async () => {
    const { db, puts } = fakeTable([
      [agent("r1", "a1", "reviewer"), agent("r2", "a2", "reviewer"), { pk: "ROOM#r1", sk: "AGENTNAME#reviewer", agentId: "a1" }],
      [agent("r3", "a3", "reviewer", { deleted: true }), agent("r1", "agent", "agent"), agent("r1", "a4", "scout")],
    ]);
    expect(await backfillAgentNames(db, "t")).toEqual([{ name: "reviewer", from: 0, to: 2 }, { name: "scout", from: 0, to: 1 }]);
    expect(puts()).toEqual([
      { pk: "AGENTNAME#reviewer", sk: "META", agentCount: 2 }, { pk: "AGENTNAME#scout", sk: "META", agentCount: 1 },
    ]);
  });

  it("corrects a wrong count, sets a stale one to 0 and leaves a right one alone, so a second run changes nothing", async () => {
    const { db, puts } = fakeTable([[agent("r1", "a1", "reviewer"), counted("reviewer", 3), counted("gone", 1), counted("scout", 1), agent("r1", "a2", "scout")]]);
    expect(await backfillAgentNames(db, "t")).toEqual([{ name: "reviewer", from: 3, to: 1 }, { name: "gone", from: 1, to: 0 }]);
    expect(puts()).toEqual([{ pk: "AGENTNAME#reviewer", sk: "META", agentCount: 1 }, { pk: "AGENTNAME#gone", sk: "META", agentCount: 0 }]);
  });
});
