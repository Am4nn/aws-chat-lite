import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, queryAll, tableName } from "../lib/db.js";
import { Gone, NotFound } from "../lib/errors.js";
import { memberKey, roomKey } from "../lib/keys.js";
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

/**
 * Every member item of the room, across pages, with only `fields` when given. Consistent reads see a join or a removal
 * at once.
 */
export function roomMembers(roomId: string, opts: { fields?: string[]; consistent?: boolean } = {}) {
  const { fields, consistent } = opts;
  return queryAll({
    KeyConditionExpression: "pk = :p AND begins_with(sk, :m)", ConsistentRead: consistent,
    ExpressionAttributeValues: { ":p": roomKey(roomId), ":m": "MEMBER#" },
    ...(fields && {
      ProjectionExpression: fields.map((f) => `#${f}`).join(", "),
      ExpressionAttributeNames: Object.fromEntries(fields.map((f) => [`#${f}`, f])),
    }),
  });
}

/** The user's member items in rooms that aren't archived, from gsi1 (eventually consistent), in join order. */
export async function liveMemberships(userId: string) {
  const items = await queryAll({ IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :u", ExpressionAttributeValues: { ":u": `USER#${userId}` } });
  return items.filter((i) => !i.archived);
}
