"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown, Bot } from "lucide-react";
import { errorText } from "@/lib/client/bff";
import { useLive } from "@/lib/client/LiveProvider";
import { groupThread } from "@/lib/client/threads";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { addPending, dropPending, failPending, keyOf, type PendingMessage } from "@/lib/client/timeline";
import { dur, easeOut, instant } from "@/lib/motion";
import type { Attachment, Me, Member, Message, ThreadSummary } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { ArchivedNotice } from "@/components/chat/ArchivedNotice";
import { Composer } from "@/components/chat/Composer";
import { TypingLine } from "@/components/chat/TypingLine";
import { useChatTimeline } from "@/components/chat/useChatTimeline";
import { useUploads } from "@/components/chat/useUploads";
import { RunBlock } from "./RunBlock";
import { UserBubble } from "./UserBubble";

const PINNED_PX = 40;
const PREFETCH_PX = 400;

const revokePreviews = (attachments: Attachment[]) =>
  attachments.forEach((a) => a.url?.startsWith("blob:") && URL.revokeObjectURL(a.url));

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
  const running = thread.status === "running";
  const chat = useChatTimeline({ roomId, chatId: threadId, meId: me.userId, initial });
  const { timeline, setTimeline, latest, apply, markFresh } = chat;
  const scroll = useStickToBottom();
  const { toBottom } = scroll;
  const [stopping, setStopping] = useState(false);
  if (stopping && !running) setStopping(false);

  useEffect(() => () => latest.current.pending.forEach((p) => revokePreviews(p.attachments)), [latest]);

  const deliver = useCallback(async (p: PendingMessage) => {
    try {
      const message = await live.request("send", {
        roomId, chatId: threadId, clientId: p.clientId, text: p.text,
        attachments: p.attachments.map(({ key, name, size, type }) => ({ key, name, size, type })),
      }) as Message;
      apply([message]);
      revokePreviews(p.attachments);
    } catch (e) {
      // Sends aren't idempotent, so a failure is left to the user: an automatic resend could post twice.
      setTimeline((t) => failPending(t, p.clientId));
      toast(errorText(e), "error");
    }
  }, [live, roomId, threadId, apply, setTimeline, toast]);

  const queue = useCallback((p: Pick<PendingMessage, "text" | "attachments">) => {
    const pending = { ...p, clientId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    markFresh([keyOf(pending)]);
    setTimeline((t) => addPending(t, pending));
    toBottom();
    void deliver(pending);
  }, [deliver, markFresh, setTimeline, toBottom]);

  const retry = useCallback((clientId: string) => {
    const failed = latest.current.pending.find((p) => p.clientId === clientId);
    if (!failed) return;
    setTimeline((t) => dropPending(t, clientId));
    queue({ text: failed.text, attachments: failed.attachments });
  }, [latest, setTimeline, queue]);

  const discard = useCallback((clientId: string) => {
    const failed = latest.current.pending.find((p) => p.clientId === clientId);
    if (failed) revokePreviews(failed.attachments);
    setTimeline((t) => dropPending(t, clientId));
  }, [latest, setTimeline]);

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
      key={`run:${runId}`} runId={runId} answer={answer} steers={steers} pending={isLast && steering ? timeline.pending : []}
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
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <AnimatePresence>
            {!scroll.atBottom && (
              <motion.button
                initial={{ opacity: 0, y: reduced ? 0 : 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduced ? 0 : 8 }}
                transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
                onClick={() => scroll.toBottom(!reduced)}
                className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-[#1c2225] px-3.5 text-[12.5px] font-medium shadow-[0_8px_24px_rgba(0,0,0,.45)] transition-[border-color,transform] hover:border-[#36403f] active:scale-[0.97]"
              >
                Latest
                <ArrowDown aria-hidden="true" size={13} className="text-lime" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
      <TypingLine roomId={roomId} chatId={threadId} meId={me.userId} />
      {archived
        ? <ArchivedNotice />
        : (
          <Composer
            members={members} meId={me.userId} mode={null} uploads={uploads} placeholder="Ask a follow-up…"
            steering={running} stopping={stopping} onStop={stop}
            onModeChange={() => {}} onSaveEdit={() => {}} onEditLast={() => false}
            onSend={(text) => queue({ text, attachments: uploads.take() })}
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

/**
 * Keeps the newest content in view while I'm at the bottom, as steps and words arrive. Scrolled up, the browser's own
 * scroll anchoring holds what I'm reading in place when content above it changes size.
 */
function useStickToBottom() {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  useLayoutEffect(() => {
    const el = ref.current!;
    el.scrollTop = el.scrollHeight;
    const follow = () => { if (pinned.current) el.scrollTop = el.scrollHeight; };
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);

  // Only my own move upwards lets go of the bottom, so a smooth scroll down to it never flickers "unpinned" on the way.
  const onScroll = useCallback(() => {
    const el = ref.current!;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_PX) pinned.current = true;
    else if (el.scrollTop < lastTop.current) pinned.current = false;
    lastTop.current = el.scrollTop;
    setAtBottom(pinned.current);
  }, []);

  const toBottom = useCallback((smooth = false) => {
    pinned.current = true;
    setAtBottom(true);
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }, []);

  return { ref, content, atBottom, onScroll, toBottom };
}
