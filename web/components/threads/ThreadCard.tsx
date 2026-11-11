"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight, Reply } from "lucide-react";
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
                <Link href={href} className="inline-flex h-6 items-center rounded-md px-1.5 font-mono text-[12px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text">
                  → #{thread.name}
                </Link>
              )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ThreadCard({ thread: t, href, readOnly, onReply }: { thread: ThreadSummary; href: string; readOnly: boolean; onReply: () => void }) {
  const reduced = useReducedMotion();
  const running = t.status === "running";
  const now = useNow(running);
  const kind = running ? "running" : t.status === "done" ? "done" : "ended";

  return (
    <div className="flex max-w-[480px] flex-col gap-1 rounded-[14px] border border-line-strong bg-surface-1 py-2.5 pl-3.5 pr-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <ThreadStatusIcon status={t.status} />
        <span className="min-w-0 truncate text-[13.5px] font-medium">
          <span className="font-mono text-[12.5px] font-normal text-text-3">#{t.number}</span> {t.name}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          {!readOnly && (
            <button
              onClick={onReply}
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-text-2 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-95"
            >
              <Reply aria-hidden="true" size={13} />
              Reply
            </button>
          )}
          <Link
            href={href}
            className="flex h-7 items-center gap-0.5 rounded-lg pl-2 pr-1.5 text-[12.5px] font-medium text-text transition-[background-color,transform] hover:bg-surface-3 active:scale-95"
          >
            Open
            <ChevronRight aria-hidden="true" size={13} className="text-text-3" />
          </Link>
        </span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={kind}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? instant : { duration: dur.fast }}
          className="flex min-w-0 items-baseline gap-2 pl-[24px] text-[12.5px]"
        >
          {running
            ? (
              <>
                <span className="min-w-0 truncate font-mono shimmer">{runLabel(t)}</span>
                <span suppressHydrationWarning className="shrink-0 font-mono text-[11.5px] tabular-nums text-lime">{runMeta(t, now)}</span>
              </>
            )
            : <span className="min-w-0 truncate text-text-2">{t.summary || runLabel(t) || "Starting…"}</span>}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
