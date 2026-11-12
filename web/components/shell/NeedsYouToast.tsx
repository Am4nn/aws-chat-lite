"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { needsYouToast } from "@/lib/client/approvals";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { instant, spring } from "@/lib/motion";
import { useNavigate } from "./NavPending";

const SHOW_MS = 8000;

/**
 * Another thread started waiting on a member: a toast drops in at the top right, clear of the room panel, and a
 * click opens that thread. The one I have open shows its own approval card instead.
 */
export function NeedsYouToast({ roomId, openThreadId, panelOpen }: { roomId: string; openThreadId?: string; panelOpen: boolean }) {
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const { threads } = useThreads();
  const [seen, setSeen] = useState(threads);
  const [toast, setToast] = useState<ReturnType<typeof needsYouToast>>(null);
  if (seen !== threads) {
    setSeen(threads);
    const next = needsYouToast(seen, threads, openThreadId);
    if (next) setToast(next);
  }
  if (toast && openThreadId && threads.find((t) => t.threadId === openThreadId)?.number === toast.number) setToast(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div aria-live="polite" className={`fixed top-[76px] z-50 transition-[right] duration-500 ease-[cubic-bezier(.2,.9,.2,1)] max-md:right-4 ${panelOpen ? "right-[340px]" : "right-5"}`}>
      <AnimatePresence>
        {toast && (
          <motion.button
            key={toast.number}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={reduced ? instant : spring.pop}
            onClick={() => {
              setToast(null);
              navigate(`/r/${roomId}/t/${toast.number}`);
            }}
            className="flex max-w-[min(360px,calc(100vw-32px))] items-center gap-3 rounded-[14px] border border-amber-line bg-amber-wash px-3.5 py-3 text-left shadow-menu transition-[border-color,transform] hover:border-amber/40 active:scale-[0.98]"
          >
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-amber" />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-text">{toast.title}</span>
              <span className="block truncate text-[12px] text-amber-muted">{toast.detail}</span>
            </span>
            <span className="ml-1.5 shrink-0 text-[12px] text-amber">Open</span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
