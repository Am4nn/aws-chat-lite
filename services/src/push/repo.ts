import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, queryAll, tableName } from "../lib/db.js";
import { subscriptionId } from "./endpoints.js";
import type { PushSubscriptionInput, StoredSubscription } from "./types.js";

const MAX_DEVICES = 10;

export const userPk = (userId: string) => `USER#${userId}`;
const subscriptionKey = (userId: string, id: string) => ({ pk: userPk(userId), sk: `PUSH#${id}` });

export type PushRepo = ReturnType<typeof pushRepo>;

/** A user's browser push subscriptions, one item per device in the user's own partition. */
export function pushRepo() {
  const db = docClient();
  const TableName = tableName();

  /** Read consistently, so a device saved a moment ago counts towards the limit. */
  async function ofUser(userId: string): Promise<StoredSubscription[]> {
    const items = await queryAll({
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ConsistentRead: true,
      ExpressionAttributeValues: { ":p": userPk(userId), ":s": "PUSH#" },
    });
    return items.map(({ pk, sk, ...sub }) => sub as StoredSubscription);
  }

  const remove = async (userId: string, id: string) => {
    await db.send(new DeleteCommand({ TableName, Key: subscriptionKey(userId, id) }));
  };

  return {
    /**
     * Keyed by the endpoint, so a browser that subscribes again overwrites its own item. Saving refreshes
     * `createdAt`, and past the limit the devices saved longest ago go: those are the ones no longer opened.
     */
    async save(userId: string, sub: PushSubscriptionInput): Promise<{ id: string }> {
      const id = subscriptionId(sub.endpoint);
      await db.send(new PutCommand({
        TableName, Item: { ...subscriptionKey(userId, id), id, userId, createdAt: new Date().toISOString(), ...sub },
      }));
      const oldestFirst = (await ofUser(userId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await Promise.all(oldestFirst.slice(0, -MAX_DEVICES).map((s) => remove(userId, s.id)));
      return { id };
    },

    remove,

    async forUsers(userIds: string[]): Promise<StoredSubscription[]> {
      return (await Promise.all(userIds.map(ofUser))).flat();
    },
  };
}
