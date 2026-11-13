"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Mentionable } from "@/lib/client/mentions";
import { dur, easeOut, instant } from "@/lib/motion";
import { MessageText } from "@/components/chat/MessageText";

const BODY = "space-y-3 break-words text-[15px] leading-[1.65] text-text-body";

// A trailing partial word would flash and then change, so it waits for its space unless the text is final.
const wholeWords = (text: string, final: boolean) => (final ? text : text.slice(0, text.search(/\S*$/)));

/**
 * The agent's answer as markdown, re-rendered as each batch streams in so no markdown symbol shows on its way to
 * becoming formatting. An answer that arrives in view fades in once; one already there when the page opened doesn't.
 */
export function AnswerText({ text, streaming, members }: { text: string; streaming: boolean; members: Mentionable[] }) {
  const reduced = useReducedMotion();
  const [arrived] = useState(streaming);
  return (
    <motion.div
      initial={arrived ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={reduced ? instant : { duration: dur.slow, ease: easeOut }}
      className={BODY}
    >
      <MessageText rich text={wholeWords(text, !streaming)} members={members} />
    </motion.div>
  );
}
