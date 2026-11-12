"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { buttonClass } from "@/components/ui/Button";

/** Inside the room's shell, so a stale chat or thread link still leaves the sidebar to pick another. */
export default function RoomNotFound() {
  const { roomId } = useParams<{ roomId: string }>();
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex w-full max-w-[380px] flex-col items-start gap-4 rounded-2xl border border-line-strong bg-surface-2 p-5">
        <p className="text-[13.5px] leading-snug text-text">This chat or thread doesn&apos;t exist, or was removed.</p>
        <Link href={`/r/${roomId}`} className={buttonClass()}>Back to the room</Link>
      </div>
    </div>
  );
}
