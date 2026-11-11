import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { budgetText } from "../budget/model.js";
import { docClient } from "../lib/db.js";
import { Conflict, NotFound } from "../lib/errors.js";
import { voiceRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

const me = { userId: "u1", username: "aman" };
const other = { userId: "u2", username: "sam" };
const MINTED = new Date("2026-11-30T23:59:00Z");

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: MINTED }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Item = Record<string, unknown>;
type Write = { Put?: { Item: Item }; Update?: { Key: Item; ConditionExpression?: string; ExpressionAttributeValues: Item } };
const cancelled = () => Object.assign(new Error("cancelled"), {
  name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
});

/**
 * A room `r` with u1 and u2 in it, `spent` of a $3 cap used this month. Writes land in `items` and the budget
 * changes are kept per month in `spends`, so a test reads exactly what was billed and when.
 */
function fakeTable(opts: { spent?: number; hits?: number } = {}) {
  const items = new Map<string, Item>([["ROOM#r|MEMBER#u1", { role: "member" }], ["ROOM#r|MEMBER#u2", { role: "member" }]]);
  items.set("ROOM#r|USAGE#2026-11", { costMicros: opts.spent ?? 0 });
  const spends: { month: string; micros: number }[] = [];
  const at = (key: Item) => `${key.pk}|${key.sk}`;
  vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) return { Item: items.get(at(c.input.Key!)) };
    if (c instanceof UpdateCommand) return { Attributes: { n: opts.hits ?? 1 } };
    if (c instanceof TransactWriteCommand) {
      const writes = c.input.TransactItems as Write[];
      for (const w of writes) {
        const session = w.Update && items.get(at(w.Update.Key));
        if (w.Update?.ConditionExpression && (!session || session.doneAt || session.userId !== w.Update.ExpressionAttributeValues[":me"])) throw cancelled();
      }
      for (const w of writes) {
        if (w.Put) items.set(at(w.Put.Item), w.Put.Item);
        else if (String(w.Update!.Key.sk).startsWith("USAGE#")) spends.push({ month: String(w.Update!.Key.sk).slice(6), micros: Number(w.Update!.ExpressionAttributeValues[":c"]) });
        else Object.assign(items.get(at(w.Update!.Key))!, { doneAt: "now", billedSec: w.Update!.ExpressionAttributeValues[":b"] });
      }
      return {};
    }
    throw new Error(`unexpected ${(c as object).constructor.name}`);
  }) as never);
  return { items, spends };
}

const later = (sec: number) => vi.setSystemTime(MINTED.getTime() + sec * 1000);

describe("mint", () => {
  it("reserves 60 s of Transcribe on the room's budget and stores the session for a day", async () => {
    const { items, spends } = fakeTable();
    await voiceRepo().mint(me, "r", "s1");
    expect(spends).toEqual([{ month: "2026-11", micros: 10_020 }]);
    const session = items.get("ROOM#r|VOICE#s1")!;
    expect(session).toMatchObject({ userId: "u1", mintedAt: MINTED.toISOString(), reservedSec: 60 });
    expect(Number(session.ttl) - MINTED.getTime() / 1000).toBe(86_400);
  });

  it("refuses with the budget copy when less than the reservation is left, and reserves nothing", async () => {
    const { spends } = fakeTable({ spent: 3_000_000 - 10_019 });
    await expect(voiceRepo().mint(me, "r", "s1")).rejects.toEqual(new Conflict(budgetText(3_000_000, "2026-11")));
    expect(spends).toEqual([]);
  });

  it("refuses the 21st dictation in an hour", async () => {
    const { spends } = fakeTable({ hits: 21 });
    await expect(voiceRepo().mint(me, "r", "s1")).rejects.toEqual(new Conflict("Slow down: 20 dictations an hour."));
    expect(spends).toEqual([]);
  });

  it("refuses someone who isn't in the room", async () => {
    fakeTable();
    await expect(voiceRepo().mint({ userId: "u9", username: "x" }, "r", "s1")).rejects.toBeInstanceOf(NotFound);
  });
});

describe("done", () => {
  it("refunds the unused seconds: 7 s spoken keeps 7 s billed", async () => {
    const { spends } = fakeTable();
    const sessionId = "s1";
    await voiceRepo().mint(me, "r", sessionId);
    later(20);
    expect(await voiceRepo().done(me, "r", sessionId, 6.2)).toEqual({ billedSeconds: 7 });
    expect(spends.map((s) => s.micros)).toEqual([10_020, -53 * 167]);
  });

  it("keeps the whole reservation for a claim past 60 s, and refunds nothing", async () => {
    const { spends } = fakeTable();
    const sessionId = "s1";
    await voiceRepo().mint(me, "r", sessionId);
    later(90);
    expect(await voiceRepo().done(me, "r", sessionId, 600)).toEqual({ billedSeconds: 60 });
    expect(spends.map((s) => s.micros)).toEqual([10_020]);
  });

  it("never bills more seconds than have passed since the session was minted", async () => {
    const { spends } = fakeTable();
    const sessionId = "s1";
    await voiceRepo().mint(me, "r", sessionId);
    later(5);
    expect(await voiceRepo().done(me, "r", sessionId, 600)).toEqual({ billedSeconds: 5 });
    expect(spends.map((s) => s.micros)).toEqual([10_020, -55 * 167]);
  });

  it("refunds on the month the session was minted in, even once a new month has begun", async () => {
    const { spends } = fakeTable();
    const sessionId = "s1";
    await voiceRepo().mint(me, "r", sessionId);
    later(120);
    await voiceRepo().done(me, "r", sessionId, 10);
    expect(spends).toEqual([{ month: "2026-11", micros: 10_020 }, { month: "2026-11", micros: -50 * 167 }]);
  });

  it("counts a dictation once: a second done is refused and refunds nothing", async () => {
    const { spends } = fakeTable();
    const sessionId = "s1";
    await voiceRepo().mint(me, "r", sessionId);
    later(20);
    await voiceRepo().done(me, "r", sessionId, 7);
    await expect(voiceRepo().done(me, "r", sessionId, 1)).rejects.toEqual(new Conflict("That dictation was already counted."));
    expect(spends.map((s) => s.micros)).toEqual([10_020, -53 * 167]);
  });

  it("someone else's session, or one that doesn't exist, is no such dictation", async () => {
    const { spends } = fakeTable();
    const sessionId = "s1";
    await voiceRepo().mint(me, "r", sessionId);
    await expect(voiceRepo().done(other, "r", sessionId, 7)).rejects.toEqual(new NotFound("No such dictation."));
    await expect(voiceRepo().done(me, "r", "nope", 7)).rejects.toEqual(new NotFound("No such dictation."));
    expect(spends.map((s) => s.micros)).toEqual([10_020]);
  });
});
