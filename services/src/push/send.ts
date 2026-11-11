import { createHash } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import webpush from "web-push";
import { docClient, tableName } from "../lib/db.js";
import type { PushKeys } from "./keys.js";
import { userPk } from "./repo.js";
import type { PushNote, StoredSubscription } from "./types.js";

/** "gone" means the push service no longer knows the device, so its subscription can be deleted. */
export type PushSender = (sub: StoredSubscription, note: PushNote) => Promise<"ok" | "gone" | "failed">;

/** A note that is still undelivered after an hour is stale news. */
const TTL_SEC = 3600;
const TIMEOUT_MS = 5000;
const FAKE_KEEP_SEC = 86400;

/** While a device is offline, its push service keeps only the newest note per topic (at most 32 base64url chars). */
const topicOf = (tag: string) => createHash("sha256").update(tag).digest("base64url").slice(0, 32);

/** Sends through the device's push service: the note encrypted for the device (RFC 8291) and signed with VAPID. */
export function liveSender(keys: PushKeys, send = webpush.sendNotification): PushSender {
  const { publicKey, privateKey, subject } = keys;
  if (!publicKey || !privateKey || !subject) throw new Error("The push keys secret needs a VAPID key pair and subject.");
  const vapidDetails = { subject, publicKey, privateKey };
  return async (sub, note) => {
    try {
      await send({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(note), {
        vapidDetails, TTL: TTL_SEC, urgency: note.urgency, topic: topicOf(note.tag), timeout: TIMEOUT_MS,
      });
      return "ok";
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return "gone";
      // The error also carries the endpoint, which is a bearer address for the device, and the push service's reply.
      console.error("push send failed", status ?? (e as Error).name);
      return "failed";
    }
  };
}

/** Records each note on its user instead of sending it, so tests and local runs can see what would have gone out. */
export function fakeSender(): PushSender {
  return async (sub, note) => {
    const now = new Date();
    await docClient().send(new PutCommand({
      TableName: tableName(),
      Item: { pk: userPk(sub.userId), sk: `PUSHED#${now.toISOString()}#${sub.id}`, note, ttl: Math.floor(now.getTime() / 1000) + FAKE_KEEP_SEC },
    }));
    return "ok";
  };
}
