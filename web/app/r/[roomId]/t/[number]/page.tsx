import { notFound } from "next/navigation";
import { serverApi, serverApiOrNull } from "@/lib/server/api";
import type { Me, Message, RoomView } from "@/lib/types";
import { ThreadMap } from "@/components/threads/map/RunMap";
import { ThreadView } from "@/components/threads/ThreadView";

/**
 * The newest page renders on the server, so a thread opens on its latest run with no loading state. `?view=map` shows
 * a run's Map instead: the one `?run=` names, else the latest.
 */
export default async function ThreadPage({ params, searchParams }: {
  params: Promise<{ roomId: string; number: string }>; searchParams: Promise<{ view?: string; run?: string }>;
}) {
  const [{ roomId, number }, query] = await Promise.all([params, searchParams]);
  const [view, me] = await Promise.all([serverApi<RoomView>(`/rooms/${roomId}`), serverApi<Me>("/me")]);
  const thread = view.threads.find((t) => String(t.number) === number);
  if (!thread) notFound();
  if (query.view === "map") {
    const agentName = view.agents.find((a) => a.agentId === thread.agentId)?.name ?? "agent";
    return <ThreadMap key={thread.threadId} thread={thread} runId={query.run} agentName={agentName} />;
  }
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
