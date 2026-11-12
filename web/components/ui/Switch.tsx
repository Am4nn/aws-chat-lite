export function Switch({ on, label, onToggle, className = "" }: { on: boolean; label: string; onToggle: () => void; className?: string }) {
  return (
    <button
      role="switch" aria-checked={on} aria-label={label} onClick={onToggle}
      className={`relative h-[18px] w-[30px] shrink-0 rounded-full border transition-[background-color,border-color,scale] duration-150 active:scale-95 ${on ? "border-lime bg-lime hover:bg-lime-soft" : "border-line-strong bg-surface-3 hover:border-line-hover"} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`absolute left-px top-px size-[14px] rounded-full transition-transform duration-200 ease-[cubic-bezier(.2,.9,.2,1)] motion-reduce:transition-none ${on ? "translate-x-3 bg-lime-ink" : "bg-text-3"}`}
      />
    </button>
  );
}
