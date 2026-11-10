import { notFound } from "next/navigation";
import { serverApi, serverApiOrNull } from "@/lib/server/api";
import { readerTimeZone } from "@/lib/server/timeZone";
import type { Me, Message, RoomView } from "@/lib/types";
import { ChatView } from "@/components/chat/ChatView";

/** The newest page renders on the server, so a chat opens on its latest messages with no loading state. */
export default async function ChatPage({ params }: { params: Promise<{ roomId: string; chatId: string }> }) {
  const { roomId, chatId } = await params;
  const [view, me, history, timeZone] = await Promise.all([
    serverApi<RoomView>(`/rooms/${roomId}`),
    serverApi<Me>("/me"),
    serverApiOrNull<{ messages: Message[] }>(`/rooms/${roomId}/chats/${chatId}/messages`),
    readerTimeZone(),
  ]);
  const chat = view.chats.find((c) => c.chatId === chatId);
  if (!chat || !history) notFound();

  return (
    <ChatView
      key={chatId}
      roomId={roomId}
      chatId={chatId}
      chatName={chat.name}
      roomName={view.room.name}
      me={me}
      role={view.me.role}
      members={view.members}
      archived={view.room.archived}
      initial={history.messages}
      serverTimeZone={timeZone}
    />
  );
}
