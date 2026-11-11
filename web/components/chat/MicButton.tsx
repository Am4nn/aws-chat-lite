"use client";

import { Mic, MicOff, Square, X } from "lucide-react";
import { formatElapsed } from "@/lib/client/format";
import { Spinner } from "@/components/ui/Spinner";
import { MAX_DICTATION_MS, type useDictation } from "./useDictation";

type Dictation = ReturnType<typeof useDictation>;

export const isDictating = (d: Dictation) => d.state === "starting" || d.state === "recording" || d.state === "finishing";

export function MicButton({ dictation }: { dictation: Dictation }) {
  const on = isDictating(dictation);
  const busy = dictation.state === "starting" || dictation.state === "finishing";
  return (
    <button
      onClick={on ? dictation.stop : () => void dictation.start()}
      aria-label={on ? "Stop dictating" : "Dictate"}
      title={on ? "Stop dictating" : "Dictation · up to 1 minute"}
      className={`grid size-[38px] shrink-0 place-items-center rounded-[11px] transition-[background,color,transform] hover:bg-surface-3 hover:text-text active:scale-95 ${on ? "bg-surface-3 text-lime" : "text-text-3"}`}
    >
      {busy ? <Spinner /> : <Mic aria-hidden="true" size={17} />}
    </button>
  );
}

/** The strip above the text box while dictating: the time against the minute, and the words so far. */
export function DictationRow({ dictation }: { dictation: Dictation }) {
  const { state, elapsedMs, live, error } = dictation;
  if (state === "error") {
    return (
      <div className="flex items-center gap-2.5 px-4 pt-2.5 text-[12.5px] text-text-2">
        <MicOff aria-hidden="true" size={13} className="shrink-0 text-amber" />
        <span role="alert" className="min-w-0 flex-1">{error}</span>
        <button onClick={dictation.cancel} aria-label="Dismiss" className="grid size-6 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-3 hover:text-text">
          <X aria-hidden="true" size={13} />
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 pt-2.5 text-[12.5px]">
      <Mic aria-hidden="true" size={13} className="shrink-0 text-lime" />
      <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-text-3">
        {formatElapsed(elapsedMs)} / {formatElapsed(MAX_DICTATION_MS)}
      </span>
      {/* Column-reverse pins the newest words to the bottom, so a long dictation loses its oldest lines from view. */}
      <div className="flex max-h-[38px] min-w-0 basis-full flex-col-reverse overflow-hidden leading-[19px] max-sm:order-last sm:flex-1 sm:basis-0">
        <p>
          {live.final && <span className="text-text">{live.final} </span>}
          {live.partial && <span className="text-text-2">{live.partial}</span>}
          {!live.final && !live.partial && <span className="text-text-3">{state === "starting" ? "Starting…" : "Listening…"}</span>}
        </p>
      </div>
      <button
        onClick={dictation.stop}
        disabled={state !== "recording"}
        aria-label="Stop dictating"
        className="ml-auto grid size-6 shrink-0 place-items-center rounded-md border border-line-strong bg-surface-3 text-text transition-[background,border-color,transform] hover:border-[#36403f] active:scale-95 disabled:pointer-events-none disabled:opacity-50"
      >
        <Square aria-hidden="true" size={9} fill="currentColor" strokeWidth={0} />
      </button>
    </div>
  );
}
