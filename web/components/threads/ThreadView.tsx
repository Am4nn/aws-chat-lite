"use client";

import { useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { Bot } from "lucide-react";
import { errorText } from "@/lib/client/bff";
import { useLive } from "@/lib/client/LiveProvider";
import { useModelPick } from "@/lib/client/ModelsProvider";
import { groupThread, isLive } from "@/lib/client/threads";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { keyOf } from "@/lib/client/timeline";
import type { Me, Member, Message, ThreadSummary } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { ArchivedNotice } from "@/components/chat/ArchivedNotice";
import { Composer } from "@/components/chat/Composer";
import { JumpPill } from "@/components/chat/JumpPill";
import { ModelPill } from "@/components/chat/ModelPill";
import { TypingLine } from "@/components/chat/TypingLine";
import { useChatTimeline } from "@/components/chat/useChatTimeline";
import { useOutbox } from "@/components/chat/useOutbox";
import { useUploads } from "@/components/chat/useUploads";
import { RunBlock } from "./RunBlock";
import { UserBubble } from "./UserBubble";
import { useStickToBottom } from "./useStickToBottom";

const PREFETCH_PX = 400;

type Props = { roomId: string; initialThread: ThreadSummary; me: Me; members: Member[]; archived: boolean; initial: Message[] };

/**
 * A thread: what people asked, and under each message that started a run, that run. A message sent while a run is
 * live steers it; Stop ends it. The thread's live status comes from the room socket, the run itself from its stream.
 */
export function ThreadView({ roomId, initialThread, me, members, archived, initial }: Props) {
  const live = useLive();
  const toast = useToast();
  const reduced = useReducedMotion();
  const uploads = useUploads(roomId);
  const thread = useThreads().byId(initialThread.threadId) ?? initialThread;
  const threadId = thread.threadId;
  // Waiting on an approval is still live: a message steers the run, and Stop ends it.
  const running = isLive(thread.status);
  const chat = useChatTimeline({ roomId, chatId: threadId, meId: me.userId, initial });
  const { timeline } = chat;
  const scroll = useStickToBottom();
  const { queue, retry, discard } = useOutbox({ roomId, chatId: threadId, chat, toBottom: scroll.toBottom });
  const [stopping, setStopping] = useState(false);
  const [pick, setPick] = useModelPick(threadId);
  if (stopping && !running) setStopping(false);

  async function stop() {
    setStopping(true);
    try {
      await live.request("stop", { roomId, threadId });
    } catch (e) {
      setStopping(false);
      toast(errorText(e), "error");
    }
  }

  // While a run is live, my unsent messages are steers waiting inside it; otherwise each will start a run of its own.
  const blocks = groupThread(timeline.messages, thread.runFirstSeq);
  const last = blocks.at(-1);
  const steering = running && last?.kind === "run" && !last.answer;
  const loose = steering ? [] : timeline.pending;

  const bubble = (m: Message) => (
    <UserBubble
      key={keyOf(m)} text={m.text} attachments={m.attachments} members={members}
      authorName={m.authorId === me.userId ? undefined : m.authorName} enter={chat.fresh.has(keyOf(m))}
      onExpired={() => void chat.refetchAround(m.seq)}
    />
  );
  const runBlock = (runId: string, answer: Message | undefined, steers: Message[], isLast: boolean) => (
    <RunBlock
      key={`run:${runId}`} roomId={roomId} runId={runId} answer={answer} steers={steers} pending={isLast && steering ? timeline.pending : []}
      active={running && runId === thread.runId} meName={me.username} members={members} onRetry={retry} onDiscard={discard}
    />
  );
  // One flat, keyed list: a message keeps its row from sending, to stored, to starting a run.
  const items: ReactNode[] = blocks.flatMap((b, i): ReactNode[] => {
    if (b.kind === "message") {
      // An answer whose first message is on an older page than the one loaded.
      return [b.message.agent ? runBlock(b.message.agent.runId, b.message, [], false) : bubble(b.message)];
    }
    const runId = b.answer?.agent?.runId ?? thread.runId ?? String(b.trigger.seq);
    return [bubble(b.trigger), runBlock(runId, b.answer, b.steers, i === blocks.length - 1)];
  });

  return (
    <div className="relative flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroll.ref}
          onScroll={() => {
            scroll.onScroll();
            if (scroll.ref.current!.scrollTop < PREFETCH_PX && chat.hasOlder && !chat.loadingOlder && !chat.olderFailed) void chat.loadOlder();
          }}
          className="h-full overflow-y-auto"
        >
          <div ref={scroll.content} className="mx-auto flex w-full max-w-[836px] flex-col gap-[18px] px-4 pb-4 pt-[26px] sm:px-7">
            {!chat.hasOlder && <ThreadIntro thread={thread} />}
            {chat.olderFailed && (
              <button onClick={chat.loadOlder} className="self-center rounded-md px-2 py-1 text-[12.5px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text">
                Couldn&apos;t load older messages · <span className="text-text-2 underline underline-offset-2">Retry</span>
              </button>
            )}
            {items}
            {loose.map((p) => (
              <UserBubble
                key={keyOf(p)} text={p.text} attachments={p.attachments} members={members} enter
                status={p.failed ? "failed" : "pending"} onRetry={() => retry(p.clientId)} onDiscard={() => discard(p.clientId)}
              />
            ))}
          </div>
        </div>
        <JumpPill show={!scroll.atBottom} onClick={() => scroll.toBottom(!reduced)}>Latest</JumpPill>
      </div>
      <TypingLine roomId={roomId} chatId={threadId} meId={me.userId} />
      {archived
        ? <ArchivedNotice />
        : (
          <Composer
            members={members} meId={me.userId} mode={null} uploads={uploads} placeholder="Ask a follow-up…"
            steering={running} stopping={stopping} onStop={stop}
            onModeChange={() => {}} onSaveEdit={() => {}} onEditLast={() => false}
            onSend={(text) => queue({ text, attachments: uploads.take(), model: pick })}
            pill={(
              <ModelPill
                value={pick} onChange={setPick} locked={running}
                taint={uploads.uploads.length ? [...thread.taint, "attachment"] : thread.taint}
              />
            )}
            onTyping={() => live.request("typing", { roomId, chatId: threadId }).catch(() => {})}
          />
        )}
    </div>
  );
}

function ThreadIntro({ thread }: { thread: ThreadSummary }) {
  return (
    <div className="flex items-center gap-3 pb-1">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#172014] text-lime">
        <Bot aria-hidden="true" size={19} />
      </span>
      <div className="min-w-0">
        <h2 className="flex items-baseline gap-2 font-display text-[19px] font-bold tracking-tight">
          <span className="font-mono text-[14px] font-medium text-text-3">#{thread.number}</span>
          <span className="truncate">{thread.name}</span>
        </h2>
        <p className="text-[13.5px] text-text-2">Messages here go to @agent. Send one while it works to steer it.</p>
      </div>
    </div>
  );
}
