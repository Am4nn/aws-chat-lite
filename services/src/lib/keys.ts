/** Single-table keys that more than one module reads or writes. */
export const roomKey = (roomId: string) => `ROOM#${roomId}`;

export const memberKey = (roomId: string, userId: string) => ({ pk: roomKey(roomId), sk: `MEMBER#${userId}` });

/** A chat's message counter, in the chat's own partition next to its messages. */
export const counterKey = (chatId: string) => ({ pk: `CHAT#${chatId}`, sk: "META" });
