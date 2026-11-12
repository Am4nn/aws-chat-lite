"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleAlert } from "lucide-react";
import { dur, spring } from "@/lib/motion";

type Tone = "done" | "error";
type Toast = { id: number; text: string; tone: Tone };
const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});

export const useToast = () => useContext(ToastContext);

/**
 * Short confirmations (and failures, so no action ever fails silently) that drop in under the header, centred so they
 * never cover a panel, and leave after a few seconds.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, tone: Tone = "done") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed left-1/2 top-[76px] z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: -14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: dur.fast } }}
              transition={spring.pop}
              className="flex items-center gap-2.5 rounded-xl border border-line-strong bg-surface-2 px-3.5 py-2.5 text-[13px] shadow-menu"
            >
              {t.tone === "error"
                ? <CircleAlert aria-hidden="true" size={15} className="text-danger" strokeWidth={2.4} />
                : <Check aria-hidden="true" size={15} className="text-lime" strokeWidth={2.6} />}
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
