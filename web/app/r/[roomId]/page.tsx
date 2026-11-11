import { redirect } from "next/navigation";
import { serverApiOrNull } from "@/lib/server/api";
import { keepQuery } from "@/lib/server/keep-query";
import type { RoomView } from "@/lib/types";

/** A room has no page of its own: it opens its first chat. A refused room renders nothing; the layout shows RoomGone. */
export default async function RoomPage({ params, searchParams }: {
  params: Promise<{ roomId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { roomId } = await params;
  const view = await serverApiOrNull<RoomView>(`/rooms/${roomId}`);
  if (!view) return null;
  redirect(keepQuery(`/r/${roomId}/c/${view.chats[0].chatId}`, await searchParams));
}
