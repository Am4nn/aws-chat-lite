import type { ReactNode } from "react";
import { serverApi, serverApiOrNull } from "@/lib/server/api";
import { readerTimeZone } from "@/lib/server/timeZone";
import { ThreadsProvider } from "@/lib/client/ThreadsProvider";
import type { Me, RoomSummary, RoomView } from "@/lib/types";
import { RoomGone } from "@/components/shell/RoomGone";
import { RoomShell } from "@/components/shell/RoomShell";

export default async function RoomLayout({ children, params }: { children: ReactNode; params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const [view, { rooms }, me, timeZone] = await Promise.all([
    serverApiOrNull<RoomView>(`/rooms/${roomId}`),
    serverApi<{ rooms: RoomSummary[] }>("/rooms"),
    serverApi<Me>("/me"),
    readerTimeZone(),
  ]);
  if (!view) return <RoomGone roomId={roomId} rooms={rooms} />;
  return (
    <ThreadsProvider view={view}>
      <RoomShell view={view} rooms={rooms} me={me} serverTimeZone={timeZone}>{children}</RoomShell>
    </ThreadsProvider>
  );
}
