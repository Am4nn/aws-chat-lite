"use client";

import { Mic, MicOff, Square, X } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import type { Dictation } from "./dictation";

export const isDictating = (d: Dictation) => d.state === "starting" || d.state === "recording" || d.state === "finishing";

/** Nothing where the browser can't dictate. While it listens the words type into the box, and the mic becomes Stop. */
export function MicButton({ dictation }: { dictation: Dictation }) {
  if (!dictation.available) return null;
  const on = isDictating(dictation);
  const busy = dictation.state === "starting" || dictation.state === "finishing";
  return (
    <button
      onClick={on ? dictation.stop : () => void dictation.start()}
      aria-label={on ? "Stop dictating" : "Dictate"}
      title={on ? "Stop dictating" : "Dictate · speak and it types"}
      className={`grid size-[38px] shrink-0 place-items-center rounded-[11px] transition-[background,color,scale] hover:bg-surface-3 hover:text-text active:scale-95 ${on ? "bg-surface-3 text-lime" : "text-text-3"}`}
    >
      {busy ? <Spinner /> : on ? <Square aria-hidden="true" size={13} fill="currentColor" strokeWidth={0} /> : <Mic aria-hidden="true" size={17} />}
    </button>
  );
}

/** Why dictation stopped, above the text box, until dismissed. */
export function DictationRow({ dictation }: { dictation: Dictation }) {
  return (
    <div className="flex items-center gap-2.5 px-4 pt-2.5 text-[12.5px] text-text-2">
      <MicOff aria-hidden="true" size={13} className="shrink-0 text-amber" />
      <span role="alert" className="min-w-0 flex-1">{dictation.error}</span>
      <button onClick={dictation.cancel} aria-label="Dismiss" className="grid size-6 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-3 hover:text-text">
        <X aria-hidden="true" size={13} />
      </button>
    </div>
  );
}
