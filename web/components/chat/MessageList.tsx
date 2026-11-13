"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { dayKey, dayLabel } from "@/lib/client/format";
import { mentionsMe, startsGroup } from "@/lib/client/messageRules";
import { pickAnchor } from "@/lib/client/scrollAnchor";
import { useNow } from "@/lib/client/useNow";
import { Spinner } from "@/components/ui/Spinner";
import { JumpPill } from "./JumpPill";
import { MessageRow, type Row, type RowActions, type RowContext } from "./MessageRow";

const PINNED_PX = 40;
const PREFETCH_PX = 600;
/** "Today" and "Yesterday" move at midnight; only the dividers read the clock, so the memoised rows never re-render for it. */
const DAY_TICK_MS = 60_000;

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
  const now = useNow(true, DAY_TICK_MS);
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

  const newDay = p.rows.map((row, i) => i === 0 || dayKey(p.rows[i - 1].message.createdAt, p.ctx.timeZone) !== dayKey(row.message.createdAt, p.ctx.timeZone));
  const groupStart = p.rows.map((row, i) => newDay[i] || startsGroup(p.rows[i - 1]?.message, row.message));
  const forMe = p.rows.map((row) => mentionsMe(row.message, p.ctx.meId));

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
                    <button onClick={p.onLoadOlder} className="rounded-md px-2 py-1 transition-[background-color,color,scale] hover:bg-surface-2 hover:text-text active:scale-[0.96]">
                      Couldn&apos;t load older messages · <span className="text-text-2 underline underline-offset-2">Retry</span>
                    </button>
                  )
                  : p.loadingOlder && <Spinner />}
              </div>
            )}
          {p.rows.map((row, i) => {
            const m = row.message;
            return (
              <Fragment key={row.key}>
                {newDay[i] && <DayDivider label={dayLabel(m.createdAt, now, p.ctx.timeZone)} />}
                <MessageRow
                  rowKey={row.key}
                  message={m}
                  status={row.status}
                  ctx={p.ctx}
                  actions={p.actions}
                  groupStart={groupStart[i]}
                  joinsAbove={forMe[i] && !groupStart[i] && forMe[i - 1]}
                  joinsBelow={forMe[i] && forMe[i + 1] === true && !groupStart[i + 1]}
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
      <JumpPill show={p.unseen > 0} onClick={p.onShowLatest}>{p.unseen} new {p.unseen === 1 ? "message" : "messages"}</JumpPill>
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
