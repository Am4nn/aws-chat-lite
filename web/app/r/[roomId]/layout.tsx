import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { serverApi, serverApiOrNull } from "@/lib/server/api";
import type { Me, RoomSummary, RoomView } from "@/lib/types";
import { RoomShell } from "@/components/shell/RoomShell";

export default async function RoomLayout({ children, params }: { children: ReactNode; params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const [view, { rooms }, me] = await Promise.all([
    serverApiOrNull<RoomView>(`/rooms/${roomId}`),
    serverApi<{ rooms: RoomSummary[] }>("/rooms"),
    serverApi<Me>("/me"),
  ]);
  if (!view) notFound();
  return <RoomShell view={view} rooms={rooms} me={me}>{children}</RoomShell>;
}
