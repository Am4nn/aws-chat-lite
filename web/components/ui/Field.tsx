import type { InputHTMLAttributes } from "react";

export function Field({ label, id, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-3">{label}</span>
      <input
        id={id}
        {...props}
        className="h-11 rounded-xl border border-line-strong bg-surface-2 px-3.5 text-[14px] text-text outline-none transition-colors placeholder:text-text-3 hover:border-[#2c3437] focus:border-lime/60"
      />
    </label>
  );
}

/** A text field inside the room panel's forms. */
export const panelInput =
  "rounded-[10px] border border-line-strong bg-ink px-3 text-[13px] text-text outline-none transition-colors placeholder:text-text-3 hover:border-[#2c3437] focus:border-lime/60 disabled:opacity-60";
