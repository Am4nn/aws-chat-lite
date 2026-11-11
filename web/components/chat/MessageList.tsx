"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown } from "lucide-react";
import { dayKey, dayLabel } from "@/lib/client/format";
import { startsGroup } from "@/lib/client/messageRules";
import { pickAnchor } from "@/lib/client/scrollAnchor";
import { dur, easeOut, instant } from "@/lib/motion";
import { Spinner } from "@/components/ui/Spinner";
import { MessageRow, type Row, type RowActions, type RowContext } from "./MessageRow";

const PINNED_PX = 40;
const PREFETCH_PX = 600;

export type Jump = { to: number | "bottom"; n: number };

function* measured(rows: Iterable<HTMLElement>) {
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    yield { key: row.dataset.key!, top: box.top, bottom: box.bottom };
  }
}

const firstVisibleRow = (scroller: HTMLElement) =>
  pickAnchor(measured(scroller.querySelectorAll<HTMLElement>("[data-key]")), scroller.getBoundingClientRect().top);

type Props = {
  rows: Row[]; ctx: RowContext; actions: RowActions; fresh: Set<string>; editingKey?: string;
  hasOlder: boolean; hasNewer: boolean; loadingOlder: boolean; olderFailed: boolean; jump: Jump | null; unseen: number;
  intro: ReactNode;
  onLoadOlder: () => void; onLoadNewer: () => void; onPinnedChange: (pinned: boolean) => void; onShowLatest: () => void;
};

/**
 * The scroller is `flex-col-reverse`, so its scroll position counts from the bottom: it opens at the newest message
 * before any script runs and stays pinned there as messages arrive. Away from the bottom, any height change (a new
 * message, a reaction row, a delete, the composer growing) would move what you're reading, so the first visible row
 * and its offset are recorded on every scroll and restored whenever the content or the viewport resizes. Browser
 * scroll anchoring is off so the two never both correct the same change.
 */
export function MessageList(p: Props) {
  const reduced = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const anchor = useRef<{ key: string; top: number }>(undefined);
  // Read by the resize observer, which runs after layout effects: a ref updated after paint still holds the value from
  // before this commit, so pages loaded forward from a jump stay put even on the render that ends detachment.
  const detached = useRef(p.hasNewer);
  useEffect(() => { detached.current = p.hasNewer; });
  const [activeKey, setActiveKey] = useState<string>();
  const [flash, setFlash] = useState<{ seq: number; n: number }>();
  const toggleActive = useCallback((key: string) => setActiveKey((a) => (a === key ? undefined : key)), []);

  useEffect(() => {
    const el = scroller.current!;
    const hold = () => {
      const a = anchor.current;
      const row = a && el.querySelector(`[data-key="${CSS.escape(a.key)}"]`);
      if ((!pinned.current || detached.current) && a && row) {
        el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top;
      }
      anchor.current = firstVisibleRow(el);
    };
    const observer = new ResizeObserver(hold);
    observer.observe(el);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current!;
    if (p.hasOlder && !p.loadingOlder && !p.olderFailed && el.scrollHeight <= el.clientHeight) p.onLoadOlder();
  });

  useEffect(() => {
    const el = scroller.current;
    if (!p.jump || !el) return;
    const behavior = reduced ? "instant" : "smooth";
    if (p.jump.to === "bottom") {
      el.scrollTo({ top: 0, behavior });
    } else {
      el.querySelector(`[data-seq="${p.jump.to}"]`)?.scrollIntoView({ block: "center", behavior });
      setFlash({ seq: p.jump.to, n: p.jump.n });
    }
  }, [p.jump, reduced]);

  function onScroll() {
    const el = scroller.current!;
    anchor.current = firstVisibleRow(el);
    const fromBottom = -el.scrollTop;
    const fromTop = el.scrollHeight - el.clientHeight - fromBottom;
    const isPinned = fromBottom < PINNED_PX;
    if (isPinned !== pinned.current) {
      pinned.current = isPinned;
      p.onPinnedChange(isPinned);
    }
    if (fromTop < PREFETCH_PX && p.hasOlder && !p.loadingOlder && !p.olderFailed) p.onLoadOlder();
    if (fromBottom < PREFETCH_PX && p.hasNewer) p.onLoadNewer();
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="flex h-full flex-col-reverse overflow-y-auto [overflow-anchor:none]">
        <div ref={content} className="mx-auto w-full max-w-[836px] px-4 pb-2 pt-6 sm:px-7">
          {!p.hasOlder
            ? p.intro
            : (
              <div className="grid h-10 place-items-center text-[12.5px] text-text-3">
                {p.olderFailed
                  ? (
                    <button onClick={p.onLoadOlder} className="rounded-md px-2 py-1 transition-colors hover:bg-surface-2 hover:text-text">
                      Couldn&apos;t load older messages · <span className="text-text-2 underline underline-offset-2">Retry</span>
                    </button>
                  )
                  : p.loadingOlder && <Spinner />}
              </div>
            )}
          {p.rows.map((row, i) => {
            const prev = p.rows[i - 1]?.message;
            const m = row.message;
            const newDay = !prev || dayKey(prev.createdAt, p.ctx.timeZone) !== dayKey(m.createdAt, p.ctx.timeZone);
            return (
              <Fragment key={row.key}>
                {newDay && <DayDivider label={dayLabel(m.createdAt, p.ctx.now, p.ctx.timeZone)} />}
                <MessageRow
                  rowKey={row.key}
                  message={m}
                  status={row.status}
                  ctx={p.ctx}
                  actions={p.actions}
                  groupStart={newDay || startsGroup(prev, m)}
                  enter={p.fresh.has(row.key)}
                  flash={flash && !row.status && flash.seq === m.seq ? flash.n : undefined}
                  editing={row.key === p.editingKey}
                  active={row.key === activeKey}
                  onActivate={toggleActive}
                />
              </Fragment>
            );
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <AnimatePresence>
          {p.unseen > 0 && (
            <motion.button
              initial={{ opacity: 0, y: reduced ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduced ? 0 : 8 }}
              transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
              onClick={p.onShowLatest}
              className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-[#1c2225] px-3.5 text-[12.5px] font-medium shadow-[0_8px_24px_rgba(0,0,0,.45)] transition-[border-color,transform] hover:border-[#36403f] active:scale-[0.97]"
            >
              {p.unseen} new {p.unseen === 1 ? "message" : "messages"}
              <ArrowDown aria-hidden="true" size={13} className="text-lime" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div role="separator" className="mb-1 mt-5 flex items-center gap-3 px-3 text-[11.5px] font-semibold text-text-3">
      <span className="h-px flex-1 bg-line" />
      {label}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
