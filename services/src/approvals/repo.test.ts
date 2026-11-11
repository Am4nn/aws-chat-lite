import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { Conflict, Forbidden } from "../lib/errors.js";
import { approvalsRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const failed = Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
const stored = { runId: "run1", roomId: "r1", step: 3, status: "approved", by: "aman", callbackId: "cb1" };

/** Answers each command from `reply`; every call is recorded. */
const fakeTable = (reply: (c: unknown) => unknown) =>
  vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => reply(c)) as never);
const updates = (send: ReturnType<typeof fakeTable>) =>
  send.mock.calls.map(([c]) => c).filter((c) => c instanceof UpdateCommand) as UpdateCommand[];
const isMember = (c: unknown) => c instanceof GetCommand && String(c.input.Key?.sk).startsWith("MEMBER#");

describe("decide", () => {
  const bea = { userId: "u2", username: "bea" };

  it("records the decision only while the approval is pending and unexpired", async () => {
    const send = fakeTable((c) => {
      if (isMember(c)) return { Item: { role: "member" } };
      if (c instanceof GetCommand) return { Item: { ...stored, status: "pending" } };
      return { Attributes: { ...stored, status: "denied", by: "bea" } };
    });
    expect(await approvalsRepo().decide(bea, "run1", 3, "deny")).toEqual({ status: "denied", by: "bea", callbackId: "cb1" });
    const [update] = updates(send);
    expect(update.input).toMatchObject({
      Key: { pk: "RUN#run1", sk: "APPROVAL#0003" },
      ConditionExpression: "#status = :pending AND expiresAt > :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pending": "pending", ":decision": "denied", ":by": "bea" },
    });
  });

  it("names the winner when someone decided first", async () => {
    fakeTable((c) => {
      if (isMember(c)) return { Item: { role: "member" } };
      if (c instanceof GetCommand) return { Item: stored };
      throw failed;
    });
    await expect(approvalsRepo().decide(bea, "run1", 3, "deny")).rejects.toThrow(new Conflict("Already approved by aman."));
  });

  it("refuses someone outside the approval's room", async () => {
    const send = fakeTable((c) => (isMember(c) ? {} : { Item: stored }));
    await expect(approvalsRepo().decide(bea, "run1", 3, "approve")).rejects.toBeInstanceOf(Forbidden);
    expect(updates(send)).toHaveLength(0);
  });
});

describe("open", () => {
  const request = {
    runId: "run1", roomId: "r1", threadId: "t1", step: 3, call: { id: "c", name: "github_comment", input: {} },
    title: "Comment?", callbackId: "cb2", expiresAt: "2026-11-11T12:00:00.000Z",
  };

  it("puts a pending item once", async () => {
    const send = fakeTable(() => ({}));
    expect(await approvalsRepo().open(request)).toMatchObject({ status: "pending", callbackId: "cb2" });
    const put = send.mock.calls[0][0] as PutCommand;
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(sk)");
  });

  it("points a pending item at the retried wait's callback", async () => {
    const send = fakeTable((c) => {
      if (c instanceof PutCommand) throw failed;
      return { Attributes: { ...request, status: "pending" } };
    });
    expect(await approvalsRepo().open(request)).toMatchObject({ callbackId: "cb2" });
    expect(updates(send)[0].input).toMatchObject({ UpdateExpression: "SET callbackId = :cb", ConditionExpression: "#status = :pending" });
  });

  it("returns an item decided already as it is", async () => {
    fakeTable((c) => {
      if (c instanceof GetCommand) return { Item: stored };
      throw failed;
    });
    expect(await approvalsRepo().open(request)).toMatchObject({ status: "approved", by: "aman" });
  });
});
