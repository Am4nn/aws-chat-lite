import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { findMember } from "../chat/membership.js";
import type { User } from "../lib/auth.js";
import { conditionFailed, docClient, tableName } from "../lib/db.js";
import { Conflict, Forbidden, NotFound } from "../lib/errors.js";
import type { ToolCall } from "../models/gateway.js";
import type { ApprovalStatus } from "../threads/types.js";
import { conflictCopy } from "./model.js";

type Approval = {
  runId: string;
  roomId: string;
  threadId: string;
  step: number;
  /** The exact input that runs once approved, so what the card shows is what executes. */
  call: ToolCall;
  title: string;
  /** The durable wait's callback; a retried wait gets a new one. */
  callbackId: string;
  expiresAt: string;
  requestedAt: string;
  status: ApprovalStatus;
  by?: string;
};

const approvalKey = (runId: string, step: number) => ({ pk: `RUN#${runId}`, sk: `APPROVAL#${String(step).padStart(4, "0")}` });
const withoutKeys = ({ pk: _pk, sk: _sk, ...rest }: Record<string, unknown>) => rest as Approval;
const names = { "#status": "status" };

/**
 * A write tool's request for a room member's go-ahead. Every change is conditional on the item still being pending,
 * so of two members deciding at once, or a decision racing the timeout or a stop, exactly one write wins.
 */
export function approvalsRepo() {
  const db = docClient();
  const TableName = tableName();

  async function get(runId: string, step: number): Promise<Approval | undefined> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: approvalKey(runId, step), ConsistentRead: true }));
    return Item && withoutKeys(Item);
  }

  /** Moves a pending approval to `status`; undefined when it was no longer pending. */
  async function close(runId: string, step: number, status: ApprovalStatus, by?: string): Promise<Approval | undefined> {
    try {
      const { Attributes } = await db.send(new UpdateCommand({
        TableName, Key: approvalKey(runId, step),
        UpdateExpression: by ? "SET #status = :status, #by = :by" : "SET #status = :status",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: by ? { ...names, "#by": "by" } : names,
        ExpressionAttributeValues: { ":status": status, ":pending": "pending", ...(by && { ":by": by }) },
        ReturnValues: "ALL_NEW",
      }));
      return withoutKeys(Attributes!);
    } catch (e) {
      if (conditionFailed(e)) return undefined;
      throw e;
    }
  }

  return {
    /** Idempotent per step: a retried request finds its item and, while it is still pending, takes the new callback. */
    async open(a: Omit<Approval, "status" | "by" | "requestedAt">): Promise<Approval> {
      const item: Approval = { ...a, requestedAt: new Date().toISOString(), status: "pending" };
      try {
        await db.send(new PutCommand({
          TableName, Item: { ...approvalKey(a.runId, a.step), ...item }, ConditionExpression: "attribute_not_exists(sk)",
        }));
        return item;
      } catch (e) {
        if (!conditionFailed(e)) throw e;
      }
      try {
        const { Attributes } = await db.send(new UpdateCommand({
          TableName, Key: approvalKey(a.runId, a.step), UpdateExpression: "SET callbackId = :cb",
          ConditionExpression: "#status = :pending", ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ":cb": a.callbackId, ":pending": "pending" }, ReturnValues: "ALL_NEW",
        }));
        return withoutKeys(Attributes!);
      } catch (e) {
        if (!conditionFailed(e)) throw e;
        return (await get(a.runId, a.step))!;
      }
    },

    /** Any member of the run's room may decide, once, before the approval expires. */
    async decide(user: User, runId: string, step: number, decision: "approve" | "deny") {
      const item = await get(runId, step);
      if (!item) throw new NotFound("Approval not found.");
      if (!(await findMember(item.roomId, user.userId))) throw new Forbidden("Only members of this room can approve.");
      const status = decision === "approve" ? "approved" : "denied";
      try {
        const { Attributes } = await db.send(new UpdateCommand({
          TableName, Key: approvalKey(runId, step),
          UpdateExpression: "SET #status = :decision, #by = :by",
          ConditionExpression: "#status = :pending AND expiresAt > :now",
          ExpressionAttributeNames: { ...names, "#by": "by" },
          ExpressionAttributeValues: { ":decision": status, ":by": user.username, ":pending": "pending", ":now": new Date().toISOString() },
          ReturnValues: "ALL_NEW",
        }));
        return { status, by: user.username, callbackId: Attributes!.callbackId as string };
      } catch (e) {
        if (!conditionFailed(e)) throw e;
        throw new Conflict(conflictCopy((await get(runId, step))!));
      }
    },

    /** Once the wait is over: a still-pending approval expires; otherwise the stored decision stands. */
    async settle(runId: string, step: number): Promise<Approval> {
      const settled = (await close(runId, step, "expired")) ?? (await get(runId, step));
      if (!settled) throw new Error(`No approval for step ${step} of run ${runId}.`);
      return settled;
    },

    /** A stop while waiting. Returns the callback to wake the run with, or undefined when it was already decided. */
    async cancel(runId: string, step: number, by: string): Promise<string | undefined> {
      return (await close(runId, step, "cancelled", by))?.callbackId;
    },
  };
}
