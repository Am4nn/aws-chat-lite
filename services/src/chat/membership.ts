import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { Gone, NotFound } from "../lib/errors.js";
import { memberKey } from "../lib/keys.js";
import type { Role } from "../rooms/access.js";

/**
 * Someone's member item, or undefined when they aren't in the room. Read strongly consistently (base-table reads
 * allow it, at twice the read cost), so someone removed a moment ago is refused at once and someone who just joined
 * is let in at once.
 */
export async function findMember(roomId: string, userId: string) {
  const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: memberKey(roomId, userId), ConsistentRead: true }));
  return Item as { role: Role; archived?: boolean } | undefined;
}

/** The caller's role in the room. An archived room stays readable but takes no new writes. */
export async function requireMember(roomId: string, userId: string, opts: { writing?: boolean } = {}): Promise<Role> {
  const member = await findMember(roomId, userId);
  if (!member) throw new NotFound("Room not found.");
  if (opts.writing && member.archived) throw new Gone("This room is archived.");
  return member.role;
}
