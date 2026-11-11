"use client";

import { motion, useReducedMotion } from "motion/react";
import { CircleAlert } from "lucide-react";
import type { Mentionable } from "@/lib/client/mentions";
import { easeOut, instant } from "@/lib/motion";
import type { Attachment } from "@/lib/types";
import { MessageAttachments } from "@/components/chat/Attachments";
import { MessageText } from "@/components/chat/MessageText";

type Props = {
  text: string; attachments: Attachment[]; members: Mentionable[];
  /** Shown above the bubble for someone else's message; my own carry no name. */
  authorName?: string;
  status?: "pending" | "failed"; enter: boolean;
  onRetry?: () => void; onDiscard?: () => void;
};

/** What people say in a thread sits on the right, so the agent's work reads as the column's main text. */
export function UserBubble({ text, attachments, members, authorName, status, enter, onRetry, onDiscard }: Props) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={enter ? { opacity: 0, y: reduced ? 0 : 6 } : false}
      animate={{ opacity: status === "pending" ? 0.6 : 1, y: 0 }}
      transition={reduced ? instant : { duration: 0.2, ease: easeOut }}
      className="flex max-w-[540px] flex-col items-end gap-1 self-end"
    >
      {authorName && <span className="px-1 text-[11.5px] font-medium text-text-3">{authorName}</span>}
      <div className="break-words rounded-[16px_16px_6px_16px] bg-surface-3 px-4 py-[11px] text-[14.5px] leading-[1.55] [&_p+p]:mt-1.5 [&_pre]:my-1.5">
        <MessageText text={text} members={members} />
        <MessageAttachments attachments={attachments} />
      </div>
      {status === "failed" && (
        <div className="flex items-center gap-2 px-1 text-[12px]">
          <CircleAlert aria-hidden="true" size={13} className="text-amber" />
          <span className="text-amber">Not sent</span>
          <button onClick={onRetry} className="text-text-2 underline-offset-2 transition-colors hover:text-text hover:underline">Retry</button>
          <button onClick={onDiscard} className="text-text-3 underline-offset-2 transition-colors hover:text-text-2 hover:underline">Discard</button>
        </div>
      )}
    </motion.div>
  );
}
