import type { ReactNode } from "react";

/** A row action in a `group` row: shown on hover or keyboard focus, and always on touch screens, which have no hover. */
export function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick} aria-label={label} title={label}
      className="grid size-7 shrink-0 place-items-center rounded-md text-text-3 opacity-0 transition-[opacity,background-color,color,scale] hover:bg-surface-3 active:scale-90 hover:text-text focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
    >
      {children}
    </button>
  );
}
