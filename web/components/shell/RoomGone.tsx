"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { RoomSummary } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";

/**
 * Stands in for a room whose view the server refuses: I was removed, left it in another tab, or followed a link to a
 * room I'm not in. It says so and goes on to my next room, staying inside the rooms layout so the tab keeps its socket.
 */
export function RoomGone({ rooms }: { rooms: RoomSummary[] }) {
  const router = useRouter();
  const toast = useToast();
  // Development runs effects twice on mount; one toast and one redirect are enough.
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    toast("You're no longer in that room");
    router.replace(rooms[0] ? `/r/${rooms[0].roomId}` : "/");
  }, [router, toast, rooms]);
  return null;
}
