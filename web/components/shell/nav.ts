/** The sidebar's order, threads above chats, so a switch between the two lists moves the way the eye does. */
export const navOrder = (threads: { threadId: string }[], chats: { chatId: string }[]) =>
  [...threads.map((t) => t.threadId), ...chats.map((c) => c.chatId)];

/** Content enters from the direction the user moved through the list. */
export const direction = (prevIndex: number, nextIndex: number): "up" | "down" => (nextIndex < prevIndex ? "up" : "down");

/**
 * Where to go after leaving or losing a room: my next room, never the one just left (the room list can still show it
 * for a moment, since it reads an eventually consistent index), or home when there is none.
 */
export function nextRoomPath(rooms: { roomId: string }[], leftRoomId: string): string {
  const next = rooms.find((r) => r.roomId !== leftRoomId);
  return next ? `/r/${next.roomId}` : "/";
}
