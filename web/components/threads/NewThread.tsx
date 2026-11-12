"use client";

import { useContext, useState } from "react";
import { RoomAgentsContext } from "@/lib/client/agents";
import { bff, errorText } from "@/lib/client/bff";
import { useModelPick } from "@/lib/client/ModelsProvider";
import { useThreads } from "@/lib/client/ThreadsProvider";
import type { Me, Member, ThreadSummary } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { useNavigate } from "@/components/shell/NavPending";
import { ArchivedNotice } from "@/components/chat/ArchivedNotice";
import { Composer } from "@/components/chat/Composer";
import { ModelPill } from "@/components/chat/ModelPill";
import { AgentAvatar } from "@/components/ui/AgentAvatar";
import { UserBubble } from "./UserBubble";

/**
 * An empty thread waiting for its first message. Sending it creates the thread (which gets its number and starts the
 * agent picked here) and then opens it, replacing this page in history so Back doesn't return to an empty form.
 */
export function NewThread({ roomId, me, members, archived }: { roomId: string; me: Me; members: Member[]; archived: boolean }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { apply } = useThreads();
  const [sent, setSent] = useState<{ text: string; failed: boolean } | null>(null);
  const [pick, setPick] = useModelPick("new");
  const agents = useContext(RoomAgentsContext);
  const [agentId, setAgentId] = useState("agent");
  const agentName = agents.find((a) => a.agentId === agentId)?.name ?? "agent";

  async function start(text: string) {
    setSent({ text, failed: false });
    try {
      const { thread } = await bff<{ thread: ThreadSummary }>(`/bff/api/rooms/${roomId}/threads`, {
        body: { text, clientId: crypto.randomUUID(), model: pick, agentId },
      });
      // The room's layout isn't fetched again on this navigation, so the new thread joins the list from the reply.
      apply(thread);
      navigate(`/r/${roomId}/t/${thread.number}`, { replace: true });
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
            <span className="mb-2.5"><AgentAvatar size={48} /></span>
            <h2 className="font-display text-[27px] font-bold tracking-tight">New thread</h2>
            <p className="text-[15px] text-text-2">
              Ask{" "}
              <select
                aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}
                className="h-7 rounded-lg border border-line-strong bg-surface-2 px-1.5 font-mono text-[13.5px] text-text outline-none transition-colors hover:border-line-hover focus-visible:border-lime/60"
              >
                {agents.map((a) => <option key={a.agentId} value={a.agentId}>@{a.name}</option>)}
              </select>{" "}
              anything. The thread gets a number and a name, and everyone in the room can follow it.
            </p>
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
            members={members} meId={me.userId} mode={null} placeholder={`Ask @${agentName} anything…`}
            onModeChange={() => {}} onSaveEdit={() => {}} onEditLast={() => false} onTyping={() => {}}
            onSend={(text) => { if (!sent || sent.failed) void start(text); }}
            pill={<ModelPill value={pick} onChange={setPick} taint={[]} />}
          />
        )}
    </div>
  );
}
