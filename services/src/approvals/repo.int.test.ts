import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auditRepo } from "../audit/repo.js";
import { Conflict, Forbidden } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { approvalsRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const rooms = roomsRepo();
const approvals = approvalsRepo();
const audit = auditRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });

/** A fresh room with aman as owner and bea as a member, and a pending approval for step 1 of a new run. */
async function pending(expiresInMs = 60_000) {
  const aman = user("aman");
  const bea = user("bea");
  const { roomId } = await rooms.createRoom(aman, "Approvals");
  const { code } = await rooms.rotateInvite(roomId, aman.userId);
  await rooms.acceptInvite(code, bea);
  const runId = randomUUID();
  await approvals.open({
    runId, roomId, threadId: randomUUID(), step: 1, title: "Comment on #1 in fake-org/playground?", callbackId: "cb-1",
    call: { id: "call-1", name: "github_comment", input: { number: 1, body: "fake" } },
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });
  return { aman, bea, roomId, runId };
}

const reasonOf = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as Error | undefined;

describe("approvals on Floci", () => {
  it("of two members deciding at once, exactly one wins and the other is told who", async () => {
    const { aman, bea, runId } = await pending();
    const results = await Promise.allSettled([
      approvals.decide(aman, runId, 1, "approve"),
      approvals.decide(bea, runId, 1, "deny"),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(Conflict);
    expect(["Already approved by aman.", "Already denied by bea."]).toContain(lost[0].reason.message);
    expect((won[0] as PromiseFulfilledResult<{ callbackId: string }>).value.callbackId).toBe("cb-1");
  });

  it("refuses a decision after the approval expires", async () => {
    const { bea, runId } = await pending(-1_000);
    expect(await reasonOf(approvals.decide(bea, runId, 1, "approve"))).toEqual(new Conflict("This approval expired."));
  });

  it("settles a pending approval as expired, and a decided one as decided", async () => {
    const first = await pending();
    expect(await approvals.settle(first.runId, 1)).toMatchObject({ status: "expired" });

    const second = await pending();
    await approvals.decide(second.bea, second.runId, 1, "approve");
    expect(await approvals.settle(second.runId, 1)).toMatchObject({ status: "approved", by: "bea" });
  });

  it("a stop cancels a pending approval, after which no one can decide it", async () => {
    const { aman, runId } = await pending();
    expect(await approvals.cancel(runId, 1, "aman")).toBe("cb-1");
    expect(await approvals.settle(runId, 1)).toMatchObject({ status: "cancelled" });
    expect(await reasonOf(approvals.decide(aman, runId, 1, "approve"))).toEqual(new Conflict("This run was stopped."));
  });

  it("a reopened approval takes the retried wait's callback", async () => {
    const { roomId, runId } = await pending();
    const again = await approvals.open({
      runId, roomId, threadId: "t", step: 1, title: "x", callbackId: "cb-2", call: { id: "c", name: "n", input: {} },
      expiresAt: new Date().toISOString(),
    });
    expect(again).toMatchObject({ callbackId: "cb-2", title: "Comment on #1 in fake-org/playground?", status: "pending" });
  });

  it("refuses someone outside the room", async () => {
    const { runId } = await pending();
    expect(await reasonOf(approvals.decide(user("eve"), runId, 1, "approve"))).toBeInstanceOf(Forbidden);
  });
});

describe("audit on Floci", () => {
  it("records a repeated entry once", async () => {
    const roomId = randomUUID();
    const entry = { id: "run1#4", at: new Date().toISOString(), actor: "aman", kind: "tool" as const, detail: "Commented" };
    await audit.record(roomId, entry);
    await audit.record(roomId, entry);
    expect((await audit.list(roomId)).entries).toEqual([entry]);
  });

  it("pages 50 newest first", async () => {
    const roomId = randomUUID();
    const start = Date.parse("2026-11-11T00:00:00.000Z");
    await Promise.all(Array.from({ length: 55 }, (_, i) =>
      audit.record(roomId, { at: new Date(start + i * 1000).toISOString(), actor: "aman", kind: "asked", detail: `e${i}` })));
    const first = await audit.list(roomId);
    expect(first.entries.map((e) => e.detail)).toEqual(Array.from({ length: 50 }, (_, i) => `e${54 - i}`));
    expect(first.next).toBeDefined();
    const second = await audit.list(roomId, first.next);
    expect(second.entries.map((e) => e.detail)).toEqual(["e4", "e3", "e2", "e1", "e0"]);
    expect(second.next).toBeUndefined();
  }, 60_000);
});
