import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger" | "amber";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-lime text-lime-ink font-semibold hover:bg-lime-soft disabled:bg-lime/50",
  ghost: "border border-line-strong bg-surface-2 text-text-2 hover:border-line-hover hover:text-text",
  /** The answer to something that needs you, such as an approval. */
  amber: "bg-amber text-amber-ink font-semibold hover:bg-amber-soft disabled:bg-amber/50",
  danger: "border border-danger-line bg-danger-wash text-danger hover:border-danger/40",
};

export function Button({ variant = "ghost", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-[10px] px-3.5 text-[13px] transition-[background,border-color,color,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  );
}
