"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Play } from "lucide-react";

const FADE = { maskImage: "linear-gradient(to bottom, #000 60%, transparent)" };

/**
 * The message that started a turn, at the head of its row on the Map, with the turn's figures and Replay under it.
 * A prompt longer than three lines fades out with a "more" that opens it in place: the block grows and the rows below
 * move down, so nothing ever covers the step cards. `stats` is null until the turn's steps have loaded, and `onReplay`
 * is left out for a turn with no steps to draw in again.
 */
export function PromptBlock({ prompt, stats, onReplay }: { prompt: string; stats: string | null; onReplay?: () => void }) {
  const text = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  const [open, setOpen] = useState(false);
  // Measured before paint, so a prompt that fits never flashes a "more".
  useLayoutEffect(() => {
    const p = text.current!;
    setClamped(p.scrollHeight > p.clientHeight + 1);
  }, [prompt]);
  const toggle = () => setOpen((o) => !o);
  const folded = clamped && !open;

  return (
    <div className="relative z-[1] flex min-h-24 w-48 shrink-0 flex-col justify-between gap-1 self-start rounded-xl border border-line-strong bg-surface-3 px-3 pb-1.5 pt-2.5">
      <div className="relative flex flex-col">
        <p
          ref={text}
          onClick={clamped ? toggle : undefined}
          style={folded ? FADE : undefined}
          className={`break-words text-[12.5px] leading-[17.5px] text-text-body ${open ? "whitespace-pre-wrap" : "max-h-[52.5px] overflow-hidden"} ${clamped ? "cursor-pointer" : ""}`}
        >
          {prompt || "This turn"}
        </p>
        {clamped && (
          <button
            onClick={toggle}
            aria-expanded={open}
            className={`rounded-sm text-[11.5px] text-text-3 transition-colors hover:text-text ${open ? "mt-1 self-end" : "absolute bottom-0 right-0 bg-linear-to-r from-transparent via-surface-3 via-40% to-surface-3 pl-4"}`}
          >
            {open ? "less" : "more"}
          </button>
        )}
      </div>
      <span className="flex h-6 items-center gap-1 font-mono text-[10.5px] tabular-nums text-text-3">
        <span suppressHydrationWarning className="truncate">{stats}</span>
        {onReplay && (
          <button
            onClick={onReplay}
            aria-label="Replay this turn"
            title="Replay"
            className="-mr-1.5 ml-auto grid size-6 shrink-0 place-items-center rounded-md transition-[background-color,color,scale] hover:bg-surface-4 hover:text-text active:scale-90"
          >
            <Play aria-hidden="true" size={10} fill="currentColor" />
          </button>
        )}
      </span>
    </div>
  );
}
