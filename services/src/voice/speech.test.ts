import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { budgetText } from "../budget/model.js";
import { docClient } from "../lib/db.js";
import { Conflict, Gone, NotFound, ValidationError } from "../lib/errors.js";
import { objects } from "../lib/s3.js";
import { speak } from "./speech.js";
import type { Speaker } from "./speaker.js";

Object.assign(process.env, {
  TABLE_NAME: "t", FILES_BUCKET: "files", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
});

afterEach(() => vi.restoreAllMocks());

const me = { userId: "u1", username: "aman" };
const ref = { chatId: "c1", seq: 4 };
const answer = (o: Record<string, unknown> = {}) => ({ roomId: "r", chatId: "c1", seq: 4, authorId: "agent", text: "Hello there.", ...o });

/** Room `r` with u1 in it and message c1/4; `stored` says whether its MP3 is already in S3. */
function fakes(opts: { message?: Record<string, unknown>; spent?: number; stored?: boolean; archived?: boolean; claimed?: boolean } = {}) {
  const spends: number[] = [];
  const claims: PutCommand[] = [];
  const released: DeleteCommand[] = [];
  vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const { pk, sk } = c.input.Key!;
      if (sk === "MEMBER#u1") return { Item: { role: "member", ...(opts.archived && { archived: true }) } };
      if (pk === "CHAT#c1" && sk === "MSG#0000000004") return { Item: opts.message ?? answer() };
      if (String(sk).startsWith("USAGE#")) return { Item: { costMicros: opts.spent ?? 0 } };
      return {};
    }
    if (c instanceof UpdateCommand) {
      // A refund is a negative spend, so only the cost is counted: no call count that refunds would inflate.
      expect(c.input.UpdateExpression).toBe("ADD costMicros :c");
      return spends.push(Number(c.input.ExpressionAttributeValues![":c"])), {};
    }
    if (c instanceof PutCommand) {
      if (opts.claimed) throw Object.assign(new Error("taken"), { name: "ConditionalCheckFailedException" });
      return claims.push(c), {};
    }
    if (c instanceof DeleteCommand) return released.push(c), {};
    throw new Error(`unexpected ${(c as object).constructor.name}`);
  }) as never);
  const puts: PutObjectCommand[] = [];
  vi.spyOn(objects(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof HeadObjectCommand) {
      if (opts.stored) return {};
      throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
    }
    if (c instanceof PutObjectCommand) return puts.push(c), {};
    throw new Error(`unexpected ${(c as object).constructor.name}`);
  }) as never);
  const texts: string[] = [];
  const speaker: Speaker = { synthesize: async (text) => (texts.push(text), Uint8Array.from([texts.length])) };
  return { spends, puts, texts, speaker, claims, released };
}

describe("speak", () => {
  it("reads an answer once: synthesized, billed per character, stored, and handed back as a signed URL", async () => {
    const { spends, puts, texts, speaker } = fakes();
    const { url, cached } = await speak(me, "r", ref, speaker);
    expect(cached).toBe(false);
    expect(texts).toEqual(["Hello there."]);
    expect(spends).toEqual([12 * 16]);
    expect(puts[0]!.input).toMatchObject({ Bucket: "files", Key: "speech/r/c1/4.mp3", ContentType: "audio/mpeg" });
    expect(url).toContain("speech/r/c1/4.mp3");
    expect(url).toContain("response-content-type=audio%2Fmpeg");
  });

  it("a 6,000-character answer is 3 Polly calls in order, joined into one file, and billed 96,000 µ$", async () => {
    const text = Array.from({ length: 250 }, (_, i) => `Sentence ${String(i).padStart(3, "0")} is long enough.`).join(" ").slice(0, 5999) + ".";
    const { spends, puts, texts, speaker } = fakes({ message: answer({ text }) });
    await speak(me, "r", ref, speaker);
    expect(text).toHaveLength(6000);
    expect(texts).toHaveLength(3);
    expect(texts.join(" ")).toBe(text);
    expect(spends).toEqual([96_000]);
    expect([...puts[0]!.input.Body as Uint8Array]).toEqual([1, 2, 3]);
  });

  it("claims the answer for a minute before synthesis, so a second play at the same time waits instead of paying again", async () => {
    const { claims, speaker } = fakes();
    await speak(me, "r", ref, speaker);
    expect(claims[0]!.input).toMatchObject({
      Item: { pk: "ROOM#r", sk: "SPEECH#c1#4" }, ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
    });
    expect(Number(claims[0]!.input.Item!.ttl) - Date.now() / 1000).toBeCloseTo(60, -1);
    const second = fakes({ claimed: true });
    await expect(speak(me, "r", ref, second.speaker)).rejects.toEqual(new Conflict("Preparing the audio; try again in a moment."));
    expect([second.texts, second.spends]).toEqual([[], []]);
  });

  it("a failed synthesis gives the claim back, so the next try can go at once", async () => {
    const { released, spends } = fakes();
    const failing: Speaker = { synthesize: async () => { throw new Error("throttled"); } };
    await expect(speak(me, "r", ref, failing)).rejects.toThrow("throttled");
    expect(released[0]!.input.Key).toEqual({ pk: "ROOM#r", sk: "SPEECH#c1#4" });
    expect(spends).toEqual([]);
  });

  it("an archived room still plays what was read before, but makes no new audio", async () => {
    const cached = fakes({ archived: true, stored: true });
    expect((await speak(me, "r", ref, cached.speaker)).cached).toBe(true);
    const fresh = fakes({ archived: true });
    await expect(speak(me, "r", ref, fresh.speaker)).rejects.toEqual(new Gone("This room is archived."));
    expect(fresh.texts).toEqual([]);
  });

  it("an answer already read plays from S3, with no synthesis and no bill", async () => {
    const { spends, puts, texts, speaker } = fakes({ stored: true });
    expect((await speak(me, "r", ref, speaker)).cached).toBe(true);
    expect([spends, puts, texts]).toEqual([[], [], []]);
  });

  it("refuses with the budget copy when the room can't afford it, before calling Polly", async () => {
    const { texts, speaker } = fakes({ spent: 3_000_000 - 100 });
    await expect(speak(me, "r", ref, speaker)).rejects.toEqual(new Conflict(budgetText(3_000_000, new Date().toISOString().slice(0, 7))));
    expect(texts).toEqual([]);
  });

  it("refuses a member's message, a removed answer, a message in another room and a non-member", async () => {
    const { speaker } = fakes({ message: answer({ authorId: "u2" }) });
    await expect(speak(me, "r", ref, speaker)).rejects.toEqual(new ValidationError("Only agent answers can be read aloud."));
    fakes({ message: answer({ deleted: "admin" }) });
    await expect(speak(me, "r", ref, speaker)).rejects.toEqual(new Gone("That answer was removed."));
    fakes({ message: answer({ roomId: "elsewhere" }) });
    await expect(speak(me, "r", ref, speaker)).rejects.toBeInstanceOf(NotFound);
    fakes();
    await expect(speak({ userId: "u9", username: "x" }, "r", ref, speaker)).rejects.toBeInstanceOf(NotFound);
  });
});
