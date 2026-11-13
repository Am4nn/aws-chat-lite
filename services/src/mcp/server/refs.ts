import { NotFound, ValidationError } from "../../lib/errors.js";
import type { RoomsRepo } from "../../rooms/repo.js";
import type { ThreadSummary } from "../../threads/types.js";

type MyRoom = Awaited<ReturnType<RoomsRepo["listMyRooms"]>>[number];

/** What a chat ref is looked up in; both the member's room view and a room's directory fit. */
interface ChatDirectory {
  room: { name: string };
  chats: { chatId: string; name: string }[];
  threads: Pick<ThreadSummary, "threadId" | "name" | "number">[];
}

/** An MCP client names rooms the way a person would, so a ref is an id or a name in any case. */
export function findRoom(rooms: MyRoom[], ref: string): MyRoom {
  const byId = rooms.find((r) => r.roomId === ref);
  if (byId) return byId;
  const named = rooms.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
  if (named.length > 1) throw new ValidationError(`Several rooms are called "${ref}": ${named.map((r) => r.roomId).join(", ")}. Use the id.`);
  if (!named[0]) throw new NotFound(`No room "${ref}" among your rooms. Try list_rooms.`);
  return named[0];
}

/**
 * `#12` is always thread 12, as it is in the app's own messages. Any other ref is tried as a chat's name, then a
 * thread's, then an id, so `#general` finds the people chat even when a thread took the same name. `listTool` is the
 * caller's own tool that lists the room, named in the refusal.
 */
export function findChat(view: ChatDirectory, ref: string, listTool: string): { chatId: string; name: string } {
  const chats = view.chats.map((c) => ({ chatId: c.chatId, name: c.name }));
  const threads = view.threads.map((t) => ({ chatId: t.threadId, name: t.name, number: t.number }));
  const number = /^#(\d+)$/.exec(ref)?.[1];
  const name = ref.replace(/^#/, "").toLowerCase();
  const found = number
    ? threads.find((t) => t.number === Number(number))
    : chats.find((c) => c.name === name) ?? threads.find((t) => t.name === name) ?? [...chats, ...threads].find((c) => c.chatId === ref);
  if (!found) throw new NotFound(`No chat or thread "${ref}" in ${view.room.name}. Try ${listTool}.`);
  return { chatId: found.chatId, name: found.name };
}
