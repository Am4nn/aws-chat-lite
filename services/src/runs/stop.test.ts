import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { endWaitingRuns } from "./stop.js";

const fake = vi.hoisted(() => ({
  cancelled: [] as unknown[][],
  woken: [] as string[],
}));
vi.mock("../approvals/repo.js", () => ({
  approvalsRepo: () => ({
    // A decided approval stays decided, but its callback still comes back, since the run must wake either way.
    cancel: async (runId: string, step: number, by: string) => (fake.cancelled.push([runId, step, by]), `cb-${runId}`),
  }),
}));
vi.mock("../approvals/decide.js", () => ({ wakeRun: async (callbackId: string) => void fake.woken.push(callbackId) }));

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => {
  vi.restoreAllMocks();
  fake.cancelled.length = 0;
  fake.woken.length = 0;
});

describe("endWaitingRuns", () => {
  it("cancels every waiting thread's approval in the archiver's name and wakes its run, across pages", async () => {
    const pages = [
      { Items: [{ activeRunId: "run1", status: "waiting", approval: { step: 3 } }], LastEvaluatedKey: { pk: "x" } },
      { Items: [{ activeRunId: "run2", status: "waiting", approval: { step: 1 } }] },
    ];
    const send = vi.spyOn(docClient(), "send").mockImplementation((async () => pages.shift()) as never);
    await endWaitingRuns("r1", "aman");
    const query = send.mock.calls[0]![0] as QueryCommand;
    expect(query.input).toMatchObject({
      KeyConditionExpression: "pk = :p AND begins_with(sk, :t)", FilterExpression: "#status = :waiting",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":p": "ROOM#r1", ":t": "THREAD#", ":waiting": "waiting" },
    });
    expect(fake.cancelled).toEqual([["run1", 3, "aman"], ["run2", 1, "aman"]]);
    expect(fake.woken).toEqual(["cb-run1", "cb-run2"]);
  });

  it("does nothing in a room with no run waiting", async () => {
    vi.spyOn(docClient(), "send").mockImplementation((async () => ({ Items: [] })) as never);
    await endWaitingRuns("r1", "aman");
    expect(fake.woken).toEqual([]);
  });
});
