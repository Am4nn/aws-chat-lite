import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { budgetText } from "../budget/model.js";
import { budgetRepo } from "../budget/repo.js";
import { requireMember } from "../chat/membership.js";
import { seqKey } from "../chat/model.js";
import type { User } from "../lib/auth.js";
import { docClient, tableName } from "../lib/db.js";
import { Conflict, Gone, NotFound, ValidationError } from "../lib/errors.js";
import { filesBucket, s3 } from "../lib/s3.js";
import { findObject, putBytes } from "../workspace/storage.js";
import { speechMicros } from "./prices.js";
import type { Speaker } from "./speaker.js";
import { speechChunks, speechText } from "./speech-text.js";

const AUDIO_URL_EXPIRY_SEC = 3600;
/** Enough to cut the wait for a long answer without crowding Polly's per-account request rate. */
const PARALLEL_SYNTHESES = 4;

const audioUrl = (key: string) =>
  getSignedUrl(s3(), new GetObjectCommand({ Bucket: filesBucket(), Key: key, ResponseContentType: "audio/mpeg" }), { expiresIn: AUDIO_URL_EXPIRY_SEC });

/**
 * An agent answer as speech. The MP3 is kept in S3 under the answer's own key, so every later play, by anyone in the
 * room, costs nothing. Polly bills as it synthesizes, so the cost is recorded before the file is stored: a failed
 * store means paying again on the next try, never a free read.
 */
export async function speak(user: User, roomId: string, ref: { chatId: string; seq: number }, speaker: Speaker): Promise<{ url: string; cached: boolean }> {
  await requireMember(roomId, user.userId);
  const { Item: message } = await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `CHAT#${ref.chatId}`, sk: seqKey(ref.seq) } }));
  if (message?.roomId !== roomId) throw new NotFound("Message not found.");
  if (message.authorId !== "agent") throw new ValidationError("Only agent answers can be read aloud.");
  if (message.deleted) throw new Gone("That answer was removed.");

  const key = `speech/${roomId}/${ref.chatId}/${ref.seq}.mp3`;
  if (await findObject(key)) return { url: await audioUrl(key), cached: true };

  const text = speechText(String(message.text ?? ""));
  if (!text) throw new ValidationError("That answer has nothing to read aloud.");
  const now = new Date();
  const cost = speechMicros(text.length);
  const budget = await budgetRepo().get(roomId, now);
  if (budget.spentMicros + cost > budget.capMicros) throw new Conflict(budgetText(budget.capMicros, budget.month));

  const chunks = speechChunks(text);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i += PARALLEL_SYNTHESES) {
    parts.push(...await Promise.all(chunks.slice(i, i + PARALLEL_SYNTHESES).map((c) => speaker.synthesize(c))));
  }
  await docClient().send(new TransactWriteCommand({ TransactItems: [budgetRepo().spend(roomId, cost, now)] }));
  await putBytes(key, Buffer.concat(parts), "audio/mpeg");
  return { url: await audioUrl(key), cached: false };
}
