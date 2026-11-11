"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { answerParagraphs, splitHeadline } from "@/lib/client/format";
import type { Mentionable } from "@/lib/client/mentions";
import { dur, easeOut, instant } from "@/lib/motion";
import { MessageText } from "@/components/chat/MessageText";

// A word's fade lasts this long; the stored text takes over only once the last words have settled.
const WORD_MS = 400;

const BODY = "break-words text-[16px] leading-[1.72] text-[#d3dcdb] [&_p+p]:mt-3 [&_pre]:my-2";

/**
 * The agent's answer: a headline (its first short line) above the body. While it streams, each word is its own span
 * that fades and sharpens in once, when it first renders; words arrive one frame's batch at a time, so a batch moves
 * together. Once the answer is final it renders as markdown, after the last words finish arriving.
 */
export function AnswerText({ text, streaming, members }: { text: string; streaming: boolean; members: Mentionable[] }) {
  const reduced = useReducedMotion();
  // An answer that was already there when the page opened appears as it is; only one written in view animates.
  const [arrived] = useState(streaming);
  const [settled, setSettled] = useState(!streaming);
  useEffect(() => {
    if (streaming || settled) return;
    const timer = setTimeout(() => setSettled(true), reduced ? 0 : WORD_MS);
    return () => clearTimeout(timer);
  }, [streaming, settled, reduced]);

  const { headline, body } = splitHeadline(text);
  return (
    <div className="flex flex-col gap-3">
      {headline && (
        <motion.h2
          initial={arrived ? { opacity: 0, y: reduced ? 0 : 18 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={reduced ? instant : { duration: dur.slow, ease: easeOut }}
          className="font-display text-[27px] font-bold leading-[1.2] tracking-[-0.018em]"
        >
          {headline}
        </motion.h2>
      )}
      {settled
        ? body && <div className={BODY}><MessageText text={body} members={members} /></div>
        : <StreamingBody text={body} final={!streaming} />}
    </div>
  );
}

function StreamingBody({ text, final }: { text: string; final: boolean }) {
  const paragraphs = answerParagraphs(text, final);
  if (!paragraphs.length) return null;
  return (
    <div className={BODY}>
      {paragraphs.map((words, p) => (
        <p key={p}>
          {words.map((w, i) => (
            <span key={i}>
              <span className="inline-block animate-[word-in_.4s_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:animate-none">{w}</span>
              {i < words.length - 1 && " "}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
