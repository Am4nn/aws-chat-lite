"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { RoomSummary } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { nextRoomPath } from "./nav";
import { useNavigate } from "./NavPending";

/**
 * Stands in for a room whose view the server refuses: I was removed, left it in another tab, or followed a link to a
 * room I'm not in. It says so and goes on to my next room, staying inside the rooms layout so the tab keeps its socket.
 * The page underneath says the same with a link home, so a redirect that doesn't land never leaves a blank screen.
 */
export function RoomGone({ roomId, rooms }: { roomId: string; rooms: RoomSummary[] }) {
  const navigate = useNavigate();
  const toast = useToast();
  // Development runs effects twice on mount; one toast and one redirect are enough.
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    toast("You're no longer in that room");
    navigate(nextRoomPath(rooms, roomId), { replace: true });
  }, [navigate, toast, rooms, roomId]);
  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 text-center">
      <p className="text-sm text-text-2">
        You&apos;re no longer in that room. <Link href="/" className="text-text underline underline-offset-2">Go to your rooms</Link>
      </p>
    </main>
  );
}
