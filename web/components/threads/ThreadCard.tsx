"use client";

import { useContext } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight, Reply } from "lucide-react";
import { agentLabel, RoomAgentsContext } from "@/lib/client/agents";
import { runLabel, runMeta } from "@/lib/client/threads";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { useNow } from "@/lib/client/useNow";
import { dur, easeOut, instant } from "@/lib/motion";
import type { Message, ThreadSummary } from "@/lib/types";
import { ThreadStatusIcon } from "./ThreadStatusIcon";

type Props = { threadRef: NonNullable<Message["threadRef"]>; roomId: string; readOnly: boolean; onReply: (threadId: string) => void };

/**
 * What a chat message handed to the agent became. The message that started a thread carries one card, which follows
 * the thread live in place rather than adding messages; one delivered into a thread carries a link to it. It grows
 * in under the message when the hand-off lands.
 */
export function ThreadRef({ threadRef, roomId, readOnly, onReply }: Props) {
  const reduced = useReducedMotion();
  const thread = useThreads().byId(threadRef.threadId);
  const href = thread && `/r/${roomId}/t/${thread.number}`;

  return (
    <AnimatePresence initial={false}>
      {thread && href && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          transition={reduced ? instant : { duration: dur.base, ease: easeOut }}
          className="overflow-hidden"
        >
          <div className="pb-0.5 pt-1.5">
            {threadRef.kind === "started"
              ? <ThreadCard thread={thread} href={href} readOnly={readOnly} onReply={() => onReply(thread.threadId)} />
              : (
                <Link href={href} className="inline-flex h-6 items-center rounded-md px-1.5 font-mono text-[12px] text-text-3 transition-[background-color,color,scale] hover:bg-surface-2 hover:text-text active:scale-[0.96]">
                  → #{thread.name}
                </Link>
              )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The thread's state, not its answer, which goes stale as the thread goes on; Open shows that. Reply tags the thread
 * in this chat's composer, the way a message here reaches it.
 */
function ThreadCard({ thread: t, href, readOnly, onReply }: { thread: ThreadSummary; href: string; readOnly: boolean; onReply: () => void }) {
  const running = t.status === "running";
  const now = useNow(running);
  const agent = agentLabel(t.agentId, useContext(RoomAgentsContext));

  return (
    <div className="flex max-w-[480px] items-center gap-2.5 rounded-[14px] border border-line-strong bg-surface-1 py-2 pl-3.5 pr-2">
      <ThreadStatusIcon status={t.status} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px]">
          <span className="font-mono font-medium">#{t.name}</span>{" "}
          <span className="font-mono text-[12px] text-text-3">{agent}</span>
        </p>
        <p className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
          <span className={`shrink-0 ${t.status === "waiting" ? "text-amber" : "text-text-2"}`}>{running ? "Running" : runLabel(t) || "Starting…"}</span>
          {t.status !== "idle" && (
            <span suppressHydrationWarning className={`truncate font-mono text-[11.5px] tabular-nums ${running ? "text-lime" : "text-text-3"}`}>
              {runMeta(t, now)}
            </span>
          )}
        </p>
      </div>
      {!readOnly && (
        <button
          onClick={onReply}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-text-2 transition-[background-color,color,scale] hover:bg-surface-3 hover:text-text active:scale-[0.96]"
        >
          <Reply aria-hidden="true" size={13} />
          Reply
        </button>
      )}
      <Link
        href={href}
        className="flex h-7 shrink-0 items-center gap-0.5 rounded-lg pl-2 pr-1.5 text-[12.5px] font-medium text-text transition-[background-color,scale] hover:bg-surface-3 active:scale-[0.96]"
      >
        Open
        <ChevronRight aria-hidden="true" size={13} className="text-text-3" />
      </Link>
    </div>
  );
}
