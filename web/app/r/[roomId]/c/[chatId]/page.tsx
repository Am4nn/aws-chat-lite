import { notFound } from "next/navigation";
import { Hash } from "lucide-react";
import { serverApi } from "@/lib/server/api";
import type { RoomView } from "@/lib/types";

export default async function ChatPage({ params }: { params: Promise<{ roomId: string; chatId: string }> }) {
  const { roomId, chatId } = await params;
  const view = await serverApi<RoomView>(`/rooms/${roomId}`);
  const chat = view.chats.find((c) => c.chatId === chatId);
  if (!chat) notFound();

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-end justify-center px-7 pb-6">
        <div className="w-full max-w-[780px]">
          <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-surface-3 text-text-2">
            <Hash aria-hidden="true" size={22} />
          </span>
          <h2 className="font-display text-[27px] font-bold tracking-tight">Welcome to #{chat.name}</h2>
          <p className="mt-1.5 text-[15px] text-text-2">This is the start of the conversation in {view.room.name}.</p>
        </div>
      </div>
      <div className="flex justify-center px-7 pb-6">
        <div className="flex h-[54px] w-full max-w-[780px] items-center rounded-2xl border border-line-strong bg-surface-2 px-[18px] text-text-3">
          Live messaging isn&apos;t switched on yet.
        </div>
      </div>
    </div>
  );
}
