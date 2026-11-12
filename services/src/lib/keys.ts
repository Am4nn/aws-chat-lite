import { seqKey } from "../chat/model.js";
import { threadSk } from "../threads/model.js";

/** Single-table keys that more than one module reads or writes. */
export const roomKey = (roomId: string) => `ROOM#${roomId}`;

/** The room's own item: its name, owner, settings and counters. */
export const roomMetaKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "META" });

export const memberKey = (roomId: string, userId: string) => ({ pk: roomKey(roomId), sk: `MEMBER#${userId}` });

/** A chat's message counter, in the chat's own partition next to its messages. */
export const counterKey = (chatId: string) => ({ pk: `CHAT#${chatId}`, sk: "META" });

export const messageKey = (chatId: string, seq: number) => ({ pk: `CHAT#${chatId}`, sk: seqKey(seq) });

/** A thread's item in the room partition, by its number, which carries its name and run status. */
export const threadKey = (roomId: string, number: number) => ({ pk: roomKey(roomId), sk: threadSk(number) });

export const runKey = (runId: string) => ({ pk: `RUN#${runId}`, sk: "META" });
