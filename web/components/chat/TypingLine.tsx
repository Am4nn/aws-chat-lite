"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { typingText } from "@/lib/client/format";
import { useLiveEvent, useLiveStatus } from "@/lib/client/LiveProvider";
import { dur, instant } from "@/lib/motion";
import { Spinner } from "@/components/ui/Spinner";

const SHOWN_MS = 5000;
// A socket that reconnects within this long never shows a notice, so a blip doesn't flicker the line.
const QUIET_MS = 1500;

type Typist = { userId: string; username: string; until: number };

/**
 * The line between the messages and the composer: who is typing, or that the connection is being restored. Its
 * height is always reserved, so nothing moves when it appears.
 */
export function TypingLine({ roomId, chatId, meId }: { roomId: string; chatId: string; meId: string }) {
  const reduced = useReducedMotion();
  const [typists, setTypists] = useState<Typist[]>([]);
  const status = useLiveStatus();
  const [offline, setOffline] = useState(false);

  useLiveEvent("typing", (e) => {
    if (e.roomId !== roomId || e.chatId !== chatId || e.userId === meId) return;
    const entry = { userId: e.userId, username: e.username, until: Date.now() + SHOWN_MS };
    setTypists((list) => [...list.filter((t) => t.userId !== e.userId), entry]);
  });
  // Their message has landed, so they've stopped typing it.
  useLiveEvent("message.new", ({ message: m }) =>
    setTypists((list) => (list.some((t) => t.userId === m.authorId) ? list.filter((t) => t.userId !== m.authorId) : list)));

  useEffect(() => {
    if (!typists.length) return;
    const next = Math.min(...typists.map((t) => t.until));
    const timer = setTimeout(() => setTypists((list) => list.filter((t) => t.until > Date.now())), next - Date.now());
    return () => clearTimeout(timer);
  }, [typists]);

  useEffect(() => {
    if (status === "open") {
      setOffline(false);
      return;
    }
    const timer = setTimeout(() => setOffline(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const text = offline ? "Reconnecting…" : typingText(typists.map((t) => t.username));
  return (
    <div className="relative mx-auto h-6 w-full max-w-[836px] px-7">
      <AnimatePresence initial={false}>
        {text && (
          <motion.p
            key={text}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? instant : { duration: dur.fast }}
            className="absolute inset-x-7 top-0.5 flex items-center gap-1.5 truncate text-[12.5px] text-text-3"
          >
            {offline && <Spinner />}
            {text}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
