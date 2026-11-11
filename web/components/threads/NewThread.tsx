"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import type { Me, Member, ThreadSummary } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { ArchivedNotice } from "@/components/chat/ArchivedNotice";
import { Composer } from "@/components/chat/Composer";
import { UserBubble } from "./UserBubble";

/**
 * An empty thread waiting for its first message. Sending it creates the thread (which gets its number and starts the
 * agent) and then opens it, replacing this page in history so Back doesn't return to an empty form.
 */
export function NewThread({ roomId, me, members, archived }: { roomId: string; me: Me; members: Member[]; archived: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [sent, setSent] = useState<{ text: string; failed: boolean } | null>(null);

  async function start(text: string) {
    setSent({ text, failed: false });
    try {
      const { thread } = await bff<{ thread: ThreadSummary }>(`/bff/api/rooms/${roomId}/threads`, {
        body: { text, clientId: crypto.randomUUID() },
      });
      router.replace(`/r/${roomId}/t/${thread.number}`);
    } catch (e) {
      setSent({ text, failed: true });
      toast(errorText(e), "error");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[836px] flex-col gap-[18px] px-4 pb-4 pt-10 sm:px-7">
          <div className="flex flex-col gap-1.5">
            <span className="mb-2.5 grid size-12 place-items-center rounded-2xl bg-[#172014] text-lime">
              <Bot aria-hidden="true" size={22} />
            </span>
            <h2 className="font-display text-[27px] font-bold tracking-tight">New thread</h2>
            <p className="text-[15px] text-text-2">Ask @agent anything. The thread gets a number and a name, and everyone in the room can follow it.</p>
          </div>
          {sent && (
            <UserBubble
              text={sent.text} attachments={[]} members={members} enter status={sent.failed ? "failed" : "pending"}
              onRetry={() => void start(sent.text)} onDiscard={() => setSent(null)}
            />
          )}
        </div>
      </div>
      {archived
        ? <ArchivedNotice />
        : (
          <Composer
            members={members} meId={me.userId} mode={null} placeholder="Ask @agent anything…"
            onModeChange={() => {}} onSaveEdit={() => {}} onEditLast={() => false} onTyping={() => {}}
            onSend={(text) => { if (!sent || sent.failed) void start(text); }}
          />
        )}
    </div>
  );
}
