import { notFound } from "next/navigation";
import { serverApi, serverApiOrNull } from "@/lib/server/api";
import type { Me, Message, RoomView } from "@/lib/types";
import { ThreadView } from "@/components/threads/ThreadView";

/** The newest page renders on the server, so a thread opens on its latest run with no loading state. */
export default async function ThreadPage({ params }: { params: Promise<{ roomId: string; number: string }> }) {
  const { roomId, number } = await params;
  const [view, me] = await Promise.all([serverApi<RoomView>(`/rooms/${roomId}`), serverApi<Me>("/me")]);
  const thread = view.threads.find((t) => String(t.number) === number);
  if (!thread) notFound();
  const history = await serverApiOrNull<{ messages: Message[] }>(`/rooms/${roomId}/chats/${thread.threadId}/messages`);
  if (!history) notFound();

  return (
    <ThreadView
      key={thread.threadId}
      roomId={roomId}
      initialThread={thread}
      me={me}
      members={view.members}
      archived={view.room.archived}
      initial={history.messages}
    />
  );
}
