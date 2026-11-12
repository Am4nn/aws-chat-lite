"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Users } from "lucide-react";
import type { MentionOption } from "@/lib/client/mentions";
import { dur, easeOut, instant } from "@/lib/motion";
import { AgentAvatar } from "@/components/ui/AgentAvatar";
import { Avatar } from "@/components/ui/Avatar";

/**
 * The @ list above the composer. Focus stays in the text box, which owns the keys and points at the highlighted option
 * (`id`-`index`), so a press picks without stealing focus.
 */
export function MentionList({ id, options, highlight, onPick, onHighlight }: {
  id: string; options: MentionOption[]; highlight: number; onPick: (name: string) => void; onHighlight: (i: number) => void;
}) {
  const reduced = useReducedMotion();
  const fast = reduced ? instant : { duration: dur.fast, ease: easeOut };
  return (
    <AnimatePresence>
      {options.length > 0 && (
        <motion.ul
          id={id}
          role="listbox"
          aria-label="Mention someone"
          initial={{ opacity: 0, y: reduced ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: fast }}
          transition={fast}
          className="absolute bottom-full left-4 z-20 mb-2 w-64 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-menu sm:left-7"
        >
          {options.map(({ name, kind }, i) => (
            <li
              key={`${kind}-${name}`}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => { e.preventDefault(); onPick(name); }}
              onMouseEnter={() => onHighlight(i)}
              className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] ${i === highlight ? "bg-surface-3 text-text" : "text-text-2"}`}
            >
              {kind === "agent" && <AgentAvatar size={22} />}
              {kind === "everyone" && <span className="grid size-[22px] place-items-center rounded-full bg-surface-4"><Users aria-hidden="true" size={12} /></span>}
              {kind === "member" && <Avatar name={name} size={22} />}
              {name}
              {kind === "agent" && <span className="ml-auto text-[11.5px] text-text-3">agent</span>}
              {kind === "everyone" && <span className="ml-auto text-[11.5px] text-text-3">whole room</span>}
            </li>
          ))}
        </motion.ul>
      )}
    </AnimatePresence>
  );
}
