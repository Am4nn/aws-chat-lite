/** Where the tip opens: above a short one-liner, or below and to the right when the text wraps inside a narrow panel. */
const PLACES = {
  above: "bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap",
  below: "left-0 top-full mt-1 w-56",
};

/**
 * A "?" that explains something on hover or focus, keeping the line it sits on short. The mark is drawn small, but
 * the button around it is a full 24 px target.
 */
export function Hint({ text, place = "above" }: { text: string; place?: keyof typeof PLACES }) {
  return (
    <span className="group relative ml-0.5 flex">
      <button aria-label={text} className="-mx-1 grid size-6 place-items-center rounded-full">
        <span
          aria-hidden="true"
          className="grid size-4 place-items-center rounded-full border border-line-strong font-mono text-[10px] leading-none text-text-3 transition-colors group-hover:border-[#36403f] group-hover:text-text-2"
        >
          ?
        </span>
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-20 rounded-lg border border-line-strong bg-surface-3 px-2.5 py-1.5 text-[11.5px] font-normal leading-snug text-text-2 opacity-0 shadow-[0_8px_24px_rgba(0,0,0,.4)] transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${PLACES[place]}`}
      >
        {text}
      </span>
    </span>
  );
}
