import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { Gone, NotFound } from "../lib/errors.js";
import type { Role } from "../rooms/access.js";

/**
 * The caller's role in the room. Read strongly consistently, so someone removed a moment ago is refused at once. An
 * archived room stays readable but takes no new writes.
 */
export async function requireMember(roomId: string, userId: string, opts: { writing?: boolean } = {}): Promise<Role> {
  const { Item } = await docClient().send(new GetCommand({
    TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: `MEMBER#${userId}` }, ConsistentRead: true,
  }));
  if (!Item) throw new NotFound("Room not found.");
  if (opts.writing && Item.archived) throw new Gone("This room is archived.");
  return Item.role as Role;
}
