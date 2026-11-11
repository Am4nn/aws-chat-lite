import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { conditionFailed, docClient, tableName } from "../lib/db.js";
import { roomKey } from "../lib/keys.js";
import type { AuditEntry } from "../threads/types.js";

const PAGE = 50;
const auditSk = (cursor: string) => `AUDIT#${cursor}`;

/**
 * A room's append-only log of what its agent asked for and did, and who changed its connections. Sorting the key by
 * time first makes a page of the newest entries one Query.
 */
export function auditRepo() {
  const db = docClient();
  const TableName = tableName();

  return {
    /**
     * Never overwrites. A caller that may run twice (a retried durable step) passes the same `id` and `at` each time,
     * so the repeat finds its entry already there and is a no-op.
     */
    async record(roomId: string, e: Omit<AuditEntry, "id"> & { id?: string }): Promise<AuditEntry> {
      const entry = { ...e, id: e.id ?? randomUUID() };
      try {
        await db.send(new PutCommand({
          TableName, Item: { pk: roomKey(roomId), sk: auditSk(`${entry.at}#${entry.id}`), ...entry },
          ConditionExpression: "attribute_not_exists(sk)",
        }));
      } catch (err) {
        if (!conditionFailed(err)) throw err;
      }
      return entry;
    },

    /** `before` is the `next` of the previous page. */
    async list(roomId: string, before?: string): Promise<{ entries: AuditEntry[]; next?: string }> {
      const { Items = [], LastEvaluatedKey } = await db.send(new QueryCommand({
        TableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :audit)",
        ExpressionAttributeValues: { ":pk": roomKey(roomId), ":audit": auditSk("") },
        ScanIndexForward: false,
        Limit: PAGE,
        ExclusiveStartKey: before ? { pk: roomKey(roomId), sk: auditSk(before) } : undefined,
      }));
      return {
        entries: Items.map(({ pk: _pk, sk: _sk, ...entry }) => entry as AuditEntry),
        next: LastEvaluatedKey && String(LastEvaluatedKey.sk).slice(auditSk("").length),
      };
    },
  };
}
