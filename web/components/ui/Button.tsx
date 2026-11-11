import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger" | "amber";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-lime text-lime-ink font-semibold hover:bg-[#d7fa8a] disabled:bg-lime/50",
  ghost: "border border-line-strong bg-surface-2 text-text-2 hover:border-[#36403f] hover:text-text",
  /** The answer to something that needs you, such as an approval. */
  amber: "bg-amber text-amber-ink font-semibold hover:bg-[#ffd08a] disabled:bg-amber/50",
  danger: "border border-[#4a2a26] bg-[#1a1110] text-[#ff9b8f] hover:border-[#6b3a33]",
};

export function Button({ variant = "ghost", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-[10px] px-3.5 text-[13px] transition-[background,border-color,color,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  );
}
