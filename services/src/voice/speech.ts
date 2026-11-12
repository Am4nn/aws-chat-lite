import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { budgetText } from "../budget/model.js";
import { budgetRepo } from "../budget/repo.js";
import { requireMember } from "../rooms/membership.js";
import type { User } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { conditionFailed, docClient, tableName } from "../lib/db.js";
import { Conflict, Gone, NotFound, ValidationError } from "../lib/errors.js";
import { messageKey, roomKey } from "../lib/keys.js";
import { filesBucket, s3 } from "../lib/s3.js";
import { findObject, putBytes } from "../workspace/storage.js";
import { speechMicros } from "./prices.js";
import type { Speaker } from "./speaker.js";
import { speechChunks, speechText } from "./speech-text.js";

const AUDIO_URL_EXPIRY_SEC = 3600;
/** Enough to cut the wait for a long answer without crowding Polly's per-account request rate. */
const PARALLEL_SYNTHESES = 4;
/** Longer than synthesizing the longest answer takes, short enough that a crashed play blocks no one for long. */
const CLAIM_SEC = 60;

const audioUrl = (key: string) =>
  getSignedUrl(s3(), new GetObjectCommand({ Bucket: filesBucket(), Key: key, ResponseContentType: "audio/mpeg" }), { expiresIn: AUDIO_URL_EXPIRY_SEC });

/**
 * One play at a time makes an answer's audio, so two members pressing play together don't both pay Polly. TTL deletion
 * can lag by days, so an expired claim is taken over rather than waited out.
 */
async function claim(Key: Record<string, string>) {
  const now = Math.floor(Date.now() / 1000);
  try {
    await docClient().send(new PutCommand({
      TableName: tableName(), Item: { ...Key, ttl: now + CLAIM_SEC }, ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
      ExpressionAttributeNames: { "#ttl": "ttl" }, ExpressionAttributeValues: { ":now": now },
    }));
  } catch (e) {
    if (conditionFailed(e)) throw new Conflict("Preparing the audio; try again in a moment.");
    throw e;
  }
}

/**
 * An agent answer as speech. The MP3 is kept in S3 under the answer's own key, so every later play, by anyone in the
 * room, costs nothing, even once the room is archived; an archived room makes no new audio. Polly bills as it
 * synthesizes, so the cost is recorded before the file is stored: a failed store means paying again on the next try,
 * never a free read.
 */
export async function speak(user: User, roomId: string, ref: { chatId: string; seq: number }, speaker: Speaker): Promise<{ url: string; cached: boolean }> {
  await requireMember(roomId, user.userId);
  const { Item: message } = await docClient().send(new GetCommand({ TableName: tableName(), Key: messageKey(ref.chatId, ref.seq) }));
  if (message?.roomId !== roomId) throw new NotFound("Message not found.");
  if (message.authorId !== "agent") throw new ValidationError("Only agent answers can be read aloud.");
  if (message.deleted) throw new Gone("That answer was removed.");

  const key = `speech/${roomId}/${ref.chatId}/${ref.seq}.mp3`;
  if (await findObject(key)) return { url: await audioUrl(key), cached: true };

  await requireMember(roomId, user.userId, { writing: true });
  const text = speechText(String(message.text ?? ""));
  if (!text) throw new ValidationError("That answer has nothing to read aloud.");
  const now = new Date();
  const cost = speechMicros(text.length);
  const budget = await budgetRepo().get(roomId, now);
  if (budget.spentMicros + cost > budget.capMicros) throw new Conflict(budgetText(budget.capMicros, budget.month));

  const claimKey = { pk: roomKey(roomId), sk: `SPEECH#${ref.chatId}#${ref.seq}` };
  await claim(claimKey);
  try {
    const chunks = speechChunks(text);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < chunks.length; i += PARALLEL_SYNTHESES) {
      parts.push(...await Promise.all(chunks.slice(i, i + PARALLEL_SYNTHESES).map((c) => speaker.synthesize(c))));
    }
    await docClient().send(new UpdateCommand(budgetRepo().spend(roomId, cost, now).Update!));
    await putBytes(key, Buffer.concat(parts), "audio/mpeg");
  } catch (e) {
    await bestEffort("speech claim release", () => docClient().send(new DeleteCommand({ TableName: tableName(), Key: claimKey })));
    throw e;
  }
  return { url: await audioUrl(key), cached: false };
}
