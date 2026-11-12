import { notFound } from "next/navigation";
import { serverApi, serverApiOrNull } from "@/lib/server/api";
import type { Me, Message, RoomView } from "@/lib/types";
import { ThreadMap } from "@/components/threads/map/RunMap";
import { ThreadView } from "@/components/threads/ThreadView";

/**
 * The newest page renders on the server, so a thread opens on its latest run; the thread skeleton stands in while it
 * does. `?view=map` shows a run's Map instead: the one `?run=` names, else the latest, with the thread's other runs a
 * click away. A room view the server refuses renders nothing here: the room layout shows RoomGone in its place.
 */
export default async function ThreadPage({ params, searchParams }: {
  params: Promise<{ roomId: string; number: string }>; searchParams: Promise<{ view?: string; run?: string }>;
}) {
  const [{ roomId, number }, query] = await Promise.all([params, searchParams]);
  const [view, me] = await Promise.all([serverApiOrNull<RoomView>(`/rooms/${roomId}`), serverApi<Me>("/me")]);
  if (!view) return null;
  const thread = view.threads.find((t) => String(t.number) === number);
  if (!thread) notFound();
  const history = await serverApiOrNull<{ messages: Message[] }>(`/rooms/${roomId}/chats/${thread.threadId}/messages`);
  if (!history) notFound();
  if (query.view === "map") {
    return <ThreadMap key={thread.threadId} thread={thread} runId={query.run} messages={history.messages} />;
  }

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
