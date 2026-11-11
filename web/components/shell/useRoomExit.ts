"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { bff, errorText } from "@/lib/client/bff";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import type { RoomSummary } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";

/**
 * Leaving the room (leave or archive) from this tab, and keeping the shell current when the room changes under it.
 * Members, chats or the archive flag changed: a refresh fetches the room view again, and the server's answer (not the
 * event) decides, so a late or repeated event can't throw anyone out. A view the server no longer gives me (I was
 * removed, or left in another tab) renders as RoomGone, which takes me on to my next room.
 */
export function useRoomExit({ roomId, rooms, onExited }: { roomId: string; rooms: RoomSummary[]; onExited: () => void }) {
  const router = useRouter();
  const toast = useToast();
  // The room I'm leaving or archiving from this tab, which navigates away by itself; its own events are ignored.
  const leaving = useRef<string>(undefined);

  useLiveEvent("room.updated", (e) => {
    if (e.roomId !== leaving.current) router.refresh();
  });

  /**
   * Out of this room and into my next one. Going there directly, not through home (which would redirect there), keeps
   * the tab's socket: home is outside the rooms layout that owns it.
   */
  return async function exitRoom(action: "leave" | "archive", done: string) {
    leaving.current = roomId;
    try {
      await bff(`/bff/api/rooms/${roomId}/${action}`, { body: {} });
      onExited();
      toast(done);
      const next = rooms.find((r) => r.roomId !== roomId);
      router.replace(next ? `/r/${next.roomId}` : "/");
    } catch (e) {
      leaving.current = undefined;
      toast(errorText(e), "error");
    }
  };
}
