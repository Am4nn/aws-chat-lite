import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { budgetRepo } from "../budget/repo.js";
import { seqKey } from "../chat/model.js";
import { docClient, tableName } from "../lib/db.js";
import { Conflict } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { deleteObjects, headObject } from "../workspace/storage.js";
import { speechMicros, transcribeMicros } from "./prices.js";
import { voiceRepo } from "./repo.js";
import { fakeSpeaker } from "./speaker.js";
import { speak } from "./speech.js";

// Runs against DynamoDB and S3 on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const spent = async (roomId: string) => (await budgetRepo().get(roomId, new Date())).spentMicros;

async function room() {
  const owner = { userId: randomUUID(), username: "owner" };
  const { roomId, generalChatId: chatId } = await roomsRepo().createRoom(owner, "Voice");
  return { owner, roomId, chatId };
}

describe("dictation sessions on Floci", () => {
  it("a session reserves 60 s, its done refunds the rest, and a second done is refused", async () => {
    const { owner, roomId } = await room();
    const before = await spent(roomId);
    const sessionId = randomUUID();
    await voiceRepo().mint(owner, roomId, sessionId);
    expect(await spent(roomId) - before).toBe(transcribeMicros(60));
    const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: `VOICE#${sessionId}` } }));
    expect(Item).toMatchObject({ userId: owner.userId, reservedSec: 60 });

    // Only a moment has passed since the mint, so the 7 s claimed are cut to that moment.
    const { billedSeconds } = await voiceRepo().done(owner, roomId, sessionId, 7);
    expect(billedSeconds).toBeGreaterThanOrEqual(1);
    expect(billedSeconds).toBeLessThanOrEqual(7);
    expect(await spent(roomId) - before).toBe(transcribeMicros(billedSeconds));

    await expect(voiceRepo().done(owner, roomId, sessionId, 7)).rejects.toEqual(new Conflict("That dictation was already counted."));
    expect(await spent(roomId) - before).toBe(transcribeMicros(billedSeconds));
  });
});

describe("read aloud on Floci", () => {
  it("stores an answer's speech once, and plays it from S3 after that", async () => {
    const { owner, roomId, chatId } = await room();
    await docClient().send(new PutCommand({
      TableName: tableName(),
      Item: { pk: `CHAT#${chatId}`, sk: seqKey(900), roomId, chatId, seq: 900, authorId: "agent", authorName: "agent", text: "**Done.** It works." },
    }));
    const key = `speech/${roomId}/${chatId}/900.mp3`;
    const before = await spent(roomId);

    expect((await speak(owner, roomId, { chatId, seq: 900 }, fakeSpeaker())).cached).toBe(false);
    expect(await headObject(key)).toMatchObject({ contentType: "audio/mpeg" });
    expect(await spent(roomId) - before).toBe(speechMicros("Done. It works.".length));

    expect((await speak(owner, roomId, { chatId, seq: 900 }, fakeSpeaker())).cached).toBe(true);
    expect(await spent(roomId) - before).toBe(speechMicros("Done. It works.".length));
    await deleteObjects([key]);
  });
});
