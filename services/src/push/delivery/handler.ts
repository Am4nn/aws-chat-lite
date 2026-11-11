import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { roomMembers } from "../../chat/membership.js";
import { docClient, queryAll, tableName } from "../../lib/db.js";
import { counterKey, roomKey } from "../../lib/keys.js";
import { threadSk } from "../../threads/model.js";
import { pushKeys } from "../keys.js";
import { noteFor } from "../notes.js";
import { pushRepo, type PushRepo } from "../repo.js";
import { fakeSender, liveSender, type PushSender } from "../send.js";
import type { PushJob } from "../types.js";

type Room = { name: string; archived: boolean; memberIds: string[] };
type Place = { name: string; thread?: number };

export type DeliveryDeps = {
  room(roomId: string): Promise<Room | undefined>;
  /** The chat or thread the job is about; undefined once it's gone. */
  place(job: PushJob): Promise<Place | undefined>;
  repo: Pick<PushRepo, "forUsers" | "remove">;
  sender(): Promise<PushSender>;
};

const get = async (Key: Record<string, string>) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key, ConsistentRead: true }))).Item;

/** Members are read at delivery, so someone removed after a mention was queued hears nothing. */
async function readRoom(roomId: string): Promise<Room | undefined> {
  const [meta, members] = await Promise.all([
    get({ pk: roomKey(roomId), sk: "META" }),
    roomMembers(roomId, { fields: ["userId"], consistent: true }),
  ]);
  return meta && { name: String(meta.name), archived: !!meta.archived, memberIds: members.map((m) => String(m.userId)) };
}

const threadName = async (roomId: string, number: number) => (await get({ pk: roomKey(roomId), sk: threadSk(number) }))?.name as string | undefined;

/** A mention's chat id may be a thread's: the chat's counter says which, and holds the thread's number. */
async function readPlace(job: PushJob): Promise<Place | undefined> {
  if (job.kind !== "mention") {
    const name = await threadName(job.roomId, job.number);
    return name === undefined ? undefined : { name };
  }
  const counter = await get(counterKey(job.chatId));
  if (counter?.roomId !== job.roomId) return undefined;
  if (counter.kind === "thread") {
    const name = await threadName(job.roomId, Number(counter.number));
    return name === undefined ? undefined : { name, thread: Number(counter.number) };
  }
  const [chat] = await queryAll({
    KeyConditionExpression: "pk = :p AND begins_with(sk, :c)", FilterExpression: "chatId = :id",
    ExpressionAttributeValues: { ":p": roomKey(job.roomId), ":c": "CHAT#", ":id": job.chatId },
  });
  return chat && { name: String(chat.name) };
}

const liveDeps = (): DeliveryDeps => ({
  room: readRoom,
  place: readPlace,
  repo: pushRepo(),
  sender: async () => (process.env.PUSH_MODE === "live" ? liveSender(await pushKeys()) : fakeSender()),
});

/**
 * Tells the job's targets who are still members (every member, for an approval) on each of their devices, and forgets
 * the devices their push service no longer knows. Never throws: the function is invoked with retries off, because a
 * late duplicate notification is worse than a missed one.
 */
export async function deliver(job: PushJob, deps: DeliveryDeps = liveDeps()): Promise<void> {
  try {
    const room = await deps.room(job.roomId);
    if (!room || room.archived) return;
    const userIds = job.kind === "approval" ? room.memberIds : job.userIds.filter((id) => room.memberIds.includes(id));
    const subs = userIds.length ? await deps.repo.forUsers(userIds) : [];
    if (!subs.length) return;
    const place = await deps.place(job);
    if (!place) return;
    const note = noteFor(job, { room: room.name, ...place });
    const send = await deps.sender();
    const results = await Promise.allSettled(subs.map((s) => send(s, note)));
    for (const r of results) if (r.status === "rejected") console.error("push send failed", r.reason);
    const gone = subs.filter((_, i) => { const r = results[i]; return r.status === "fulfilled" && r.value === "gone"; });
    await Promise.all(gone.map((s) => deps.repo.remove(s.userId, s.id)));
  } catch (e) {
    console.error("push delivery failed", job.kind, e);
  }
}

export const handler = (job: PushJob) => deliver(job);
