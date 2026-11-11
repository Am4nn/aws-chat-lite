import { serverApi } from "@/lib/server/api";
import type { Me, RoomView } from "@/lib/types";
import { NewThread } from "@/components/threads/NewThread";

export default async function NewThreadPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const [view, me] = await Promise.all([serverApi<RoomView>(`/rooms/${roomId}`), serverApi<Me>("/me")]);
  return <NewThread roomId={roomId} me={me} members={view.members} archived={view.room.archived} />;
}
