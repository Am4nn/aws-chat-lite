import { redirect } from "next/navigation";
import { serverApi } from "@/lib/server/api";
import { keepQuery } from "@/lib/server/keep-query";
import type { Me, RoomSummary } from "@/lib/types";
import { CreateRoom } from "@/components/rooms/CreateRoom";

/** Home sends you into your first room; with no rooms yet it shows what to do next. */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [me, { rooms }] = await Promise.all([serverApi<Me>("/me"), serverApi<{ rooms: RoomSummary[] }>("/rooms")]);
  if (rooms.length > 0) redirect(keepQuery(`/r/${rooms[0].roomId}`, await searchParams));
  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4">
      <div className="w-full max-w-[380px]">
        <h1 className="font-display text-2xl font-bold">No rooms yet</h1>
        <p className="mt-2 mb-6 text-sm text-text-2">
          {me.isCreator ? "Create your first room. It starts with a #general chat." : `Hi ${me.username}. Ask someone for an invite link to join their room.`}
        </p>
        {me.isCreator && <CreateRoom />}
      </div>
    </main>
  );
}
