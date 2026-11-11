import type { Chat, ThreadSummary } from "../types";

type Place = { kind: "chat" | "thread"; label: string; href: string };

/**
 * Where a search hit lives and how to get there. Search spans the agent threads too, whose messages carry the thread's
 * id as their chat id; a thread opens by its number, at its latest run.
 */
export function searchPlace(
  roomId: string, chatId: string, seq: number,
  chats: Pick<Chat, "chatId" | "name">[], threads: Pick<ThreadSummary, "threadId" | "number" | "name">[],
): Place {
  const thread = threads.find((t) => t.threadId === chatId);
  if (thread) return { kind: "thread", label: `#${thread.number} ${thread.name}`, href: `/r/${roomId}/t/${thread.number}` };
  const name = chats.find((c) => c.chatId === chatId)?.name ?? "chat";
  return { kind: "chat", label: name, href: `/r/${roomId}/c/${chatId}?m=${seq}` };
}
