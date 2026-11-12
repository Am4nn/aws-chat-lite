import type { ReactNode } from "react";

/**
 * A "?" that explains something on hover or focus, keeping its row to one line of text. The mark is drawn small, but
 * the button around it is a full 24 px target. `below`: the tip opens under the row it sits in and spans it, for a row
 * at the top of a narrow scrolling panel, which would clip a tip above it or scroll sideways for one beside it. That
 * row must be positioned. `mark`: an icon to show in place of the "?", for a hint that also marks a state.
 */
export function Hint({ text, below = false, mark }: { text: string; below?: boolean; mark?: ReactNode }) {
  return (
    <span className={`group ml-0.5 flex ${below ? "" : "relative"}`}>
      <button type="button" aria-label={text} className="-mx-1 grid size-6 place-items-center rounded-full">
        {mark ?? (
          <span
            aria-hidden="true"
            className="grid size-4 place-items-center rounded-full border border-line-strong font-mono text-[10px] leading-none text-text-3 transition-colors group-hover:border-line-hover group-hover:text-text-2"
          >
            ?
          </span>
        )}
      </button>
      {/* The button already carries the text as its name; the tip is for sighted users only, so it isn't read twice. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute z-20 rounded-lg border border-line-strong bg-surface-3 px-2.5 py-1.5 text-[11.5px] leading-snug text-text-2 opacity-0 shadow-pop transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${
          below ? "inset-x-0 top-full mt-1" : "bottom-full left-1/2 mb-2 w-max max-w-[240px] -translate-x-1/2"
        }`}
      >
        {text}
      </span>
    </span>
  );
}
