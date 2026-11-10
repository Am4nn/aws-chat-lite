import { redirect } from "next/navigation";
import { serverApi } from "@/lib/server/api";

type Me = { username: string; isCreator: boolean };
type Rooms = { rooms: { roomId: string; name: string }[] };

/** Home sends you into your first room; with no rooms yet it explains what to do next. */
export default async function Home() {
  const [me, { rooms }] = await Promise.all([serverApi<Me>("/me"), serverApi<Rooms>("/rooms")]);
  if (rooms.length > 0) redirect(`/r/${rooms[0].roomId}`);
  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 text-center">
      <div className="max-w-sm">
        <h1 className="font-display text-2xl font-bold">No rooms yet</h1>
        <p className="mt-2 text-sm text-text-2">
          {me.isCreator ? "Create your first room to get started." : `Hi ${me.username}. Ask someone for an invite link to join a room.`}
        </p>
      </div>
    </main>
  );
}
