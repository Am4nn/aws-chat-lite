"use client";

import { useState, type ReactNode } from "react";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import { Bot, Search } from "lucide-react";
import { dur, easeOut } from "@/lib/motion";

export type PaletteItem = { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void };

const ASK = /^@([\w-]+)\s+\S/;

/**
 * Ctrl K: one place to jump anywhere or run an action. Typing filters every group at once, and typing "@<agent> …"
 * for one of the room's agents offers to start a thread with it (`onAsk`).
 */
export function CommandPalette({ open, onClose, items, agentNames, onAsk }: {
  open: boolean; onClose: () => void; items: PaletteItem[]; agentNames: string[]; onAsk?: (text: string) => void;
}) {
  const groups = [...new Set(items.map((i) => i.group))];
  const [query, setQuery] = useState("");
  const asked = ASK.exec(query.trim())?.[1].toLowerCase();
  const ask = onAsk && asked && agentNames.includes(asked) ? query.trim() : null;
  // Each opening starts empty, however it was closed (Esc, a pick, or Ctrl K again).
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (!open) setQuery("");
  }
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40">
          <motion.button
            aria-label="Close command palette"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: dur.fast }}
            className="absolute inset-0 cursor-default bg-[rgba(4,6,7,.66)]"
          />
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: dur.fast } }}
            transition={{ duration: dur.base, ease: easeOut }}
            className="absolute left-1/2 top-[110px] w-[620px] max-w-[calc(100vw-32px)] -translate-x-1/2"
          >
            <Command
              label="Command palette"
              loop
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                onClose();
              }}
              className="overflow-hidden rounded-[18px] border border-line-strong bg-surface-2 shadow-modal"
            >
              <div className="flex h-14 items-center gap-2.5 border-b border-surface-4 px-4">
                <Search aria-hidden="true" size={17} className="text-text-3" />
                <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Jump anywhere, or @agent to start a thread…" className="h-full flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-text-3" />
                <kbd className="font-mono text-[11px] text-text-3">Esc</kbd>
              </div>
              <Command.List className="max-h-[360px] overflow-y-auto p-2">
                {!ask && <Command.Empty className="px-3 py-6 text-center text-sm text-text-3">Nothing matches.</Command.Empty>}
                {ask && (
                  <Command.Item
                    forceMount
                    value={`ask ${ask}`}
                    onSelect={() => { onClose(); onAsk!(ask); }}
                    className="flex h-11 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 text-[13.5px] text-text-2 data-[selected=true]:bg-surface-3 data-[selected=true]:text-text"
                  >
                    <span className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-lime-wash text-lime"><Bot aria-hidden="true" size={14} /></span>
                    <span className="min-w-0 truncate">{ask}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11.5px] text-text-3">new thread</span>
                  </Command.Item>
                )}
                {groups.map((g) => (
                  <Command.Group key={g} heading={g} className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-text-3">
                    {items.filter((i) => i.group === g).map((item, n) => (
                      <Command.Item
                        key={item.id}
                        value={`${item.group} ${item.label}`}
                        onSelect={() => { onClose(); item.run(); }}
                        style={{ animationDelay: `${n * 35}ms` }}
                        className="flex h-11 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 text-[13.5px] text-text-2 animate-[row-in_.35s_cubic-bezier(.2,.9,.2,1)_both] data-[selected=true]:bg-surface-3 data-[selected=true]:text-text motion-reduce:animate-none"
                      >
                        <span className="grid size-[26px] place-items-center rounded-lg bg-surface-4 text-[11px] font-bold text-text">{item.icon}</span>
                        {item.label}
                        {item.hint && <span className="ml-auto font-mono text-[11.5px] text-text-3">{item.hint}</span>}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
            </Command>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
