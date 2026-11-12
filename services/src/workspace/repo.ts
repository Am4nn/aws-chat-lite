import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, failedAt, queryAll, tableName, transactionConflict } from "../lib/db.js";
import { Conflict, ValidationError } from "../lib/errors.js";
import { roomKey, roomMetaKey } from "../lib/keys.js";
import { countTowardsRate } from "../lib/rate.js";
import { MAX_ROOM_FILES, OVER_QUOTA, ROOM_FILES_BYTES, TOO_MANY } from "./limits.js";
import type { FileAuthor, RoomFile, StoredFile } from "./types.js";

/** The room's file limits refused a write; the message says which. */
export class QuotaError extends ValidationError {}

const ATTEMPTS = 3;
const UPLOADS_PER_HOUR = 100;
const fileKey = (roomId: string, path: string) => ({ pk: roomKey(roomId), sk: `FILE#${path}` });

const storedFile = (item: Record<string, unknown>): StoredFile => ({
  path: String(item.path), size: Number(item.size), contentType: String(item.contentType), v: Number(item.v),
  updatedAt: String(item.updatedAt), updatedBy: item.updatedBy as FileAuthor, objectKey: String(item.objectKey),
});

/** A file as members see it: where it lives in S3 stays on the server. */
export function roomFile({ objectKey: _, ...file }: StoredFile): RoomFile {
  return file;
}

/**
 * The room's files: one FILE item per path, pointing at the S3 object that holds its bytes, versioned so that two
 * writers can't silently overwrite each other. META keeps the room's running totals, changed only with ADD in the same
 * transaction as the FILE item, so the totals are always the sum of the files and the quota can't be raced past.
 */
export function workspaceRepo() {
  const db = docClient();
  const TableName = tableName();

  async function get(roomId: string, path: string): Promise<StoredFile | undefined> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: fileKey(roomId, path), ConsistentRead: true }));
    return Item && storedFile(Item);
  }

  async function usage(roomId: string) {
    const { Item } = await db.send(new GetCommand({
      TableName, Key: roomMetaKey(roomId), ConsistentRead: true, ProjectionExpression: "filesBytes, filesCount",
    }));
    return { bytes: Number(Item?.filesBytes ?? 0), count: Number(Item?.filesCount ?? 0) };
  }

  /** Adds `bytes` and `count` (negative to give space back) to the room's totals. */
  const addToTotals = (roomId: string, bytes: number, count: number, ConditionExpression?: string, values = {}) => ({
    Update: {
      TableName, Key: roomMetaKey(roomId), UpdateExpression: "ADD filesBytes :bytes, filesCount :count", ConditionExpression,
      ExpressionAttributeValues: { ":bytes": bytes, ":count": count, ...values },
    },
  });

  return {
    get,
    usage,
    countUpload: (userId: string) => countTowardsRate(`UPLOADS#${userId}`, {
      windowSec: 3600, max: UPLOADS_PER_HOUR, message: `Slow down: ${UPLOADS_PER_HOUR} uploads an hour.`,
    }),

    /** Sorted by path, because the sort key is the path. */
    async list(roomId: string): Promise<StoredFile[]> {
      const items = await queryAll({
        KeyConditionExpression: "pk = :p AND begins_with(sk, :f)", ConsistentRead: true,
        ExpressionAttributeValues: { ":p": roomKey(roomId), ":f": "FILE#" },
      });
      return items.map(storedFile);
    },

    /**
     * Points `path` at a new object. The FILE put only applies over the version read, so a writer that lost a race
     * re-reads and retries. The totals only grow while they stay within the limits, so two writes racing for the
     * room's last bytes can't both land; an overwrite counts only its difference in size.
     */
    async commit(
      roomId: string, c: { path: string; objectKey: string; size: number; contentType: string; by: FileAuthor },
    ): Promise<{ file: StoredFile; replaced?: StoredFile }> {
      for (let attempt = 1; ; attempt++) {
        const prev = await get(roomId, c.path);
        const delta = c.size - (prev?.size ?? 0);
        const added = prev ? 0 : 1;
        const file: StoredFile = {
          path: c.path, size: c.size, contentType: c.contentType, v: (prev?.v ?? 0) + 1,
          updatedAt: new Date().toISOString(), updatedBy: c.by, objectKey: c.objectKey,
        };
        try {
          await db.send(new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName, Item: { ...fileKey(roomId, c.path), ...file },
                  ConditionExpression: "attribute_not_exists(pk) OR #v = :prevV",
                  ExpressionAttributeNames: { "#v": "v" }, ExpressionAttributeValues: { ":prevV": prev?.v ?? 0 },
                },
              },
              addToTotals(roomId, delta, added,
                "attribute_exists(pk) AND (attribute_not_exists(filesBytes) OR filesBytes <= :bytesRoom)"
                + " AND (attribute_not_exists(filesCount) OR filesCount <= :countRoom)",
                { ":bytesRoom": ROOM_FILES_BYTES - delta, ":countRoom": MAX_ROOM_FILES - added }),
            ],
          }));
          return { file, ...(prev && { replaced: prev }) };
        } catch (e) {
          const raced = failedAt(e, 0) || transactionConflict(e);
          if (raced && attempt < ATTEMPTS) continue;
          if (raced) throw new Conflict(`${c.path} keeps changing; try again.`);
          if (failedAt(e, 1)) {
            const now = await usage(roomId);
            throw new QuotaError(added && now.count + added > MAX_ROOM_FILES ? TOO_MANY : OVER_QUOTA);
          }
          throw e;
        }
      }
    },

    /**
     * Deletes `path` and gives its space back. With `expectV`, only that version is deleted: a newer one someone else
     * wrote is kept and returned instead.
     */
    async remove(roomId: string, path: string, expectV?: number): Promise<{ removed?: StoredFile; kept?: StoredFile }> {
      for (let attempt = 1; ; attempt++) {
        const current = await get(roomId, path);
        if (!current) return {};
        if (expectV !== undefined && current.v !== expectV) return { kept: current };
        try {
          // Conditioned on the version read even without `expectV`, so the space given back is that version's size.
          await db.send(new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  TableName, Key: fileKey(roomId, path), ConditionExpression: "#v = :v",
                  ExpressionAttributeNames: { "#v": "v" }, ExpressionAttributeValues: { ":v": current.v },
                },
              },
              addToTotals(roomId, -current.size, -1),
            ],
          }));
          return { removed: current };
        } catch (e) {
          const raced = failedAt(e, 0) || transactionConflict(e);
          if (raced && attempt < ATTEMPTS) continue;
          if (raced) throw new Conflict(`${path} keeps changing; try again.`);
          throw e;
        }
      }
    },
  };
}

export type WorkspaceRepo = ReturnType<typeof workspaceRepo>;
