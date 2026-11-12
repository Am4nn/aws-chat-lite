import type { ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

type Variant = "primary" | "ghost" | "danger" | "amber";
type Size = "sm" | "md" | "lg";

// Hover sits behind `not-disabled:` so a disabled button doesn't light up under the pointer. It is `not-disabled`
// rather than `enabled` because links styled as buttons never match `:enabled`.
const VARIANTS: Record<Variant, string> = {
  primary: "bg-lime text-lime-ink font-semibold not-disabled:hover:bg-lime-soft",
  ghost: "border border-line-strong bg-surface-2 text-text-2 not-disabled:hover:border-line-hover not-disabled:hover:text-text",
  /** The answer to something that needs you, such as an approval. */
  amber: "bg-amber text-amber-ink font-semibold not-disabled:hover:bg-amber-soft",
  danger: "border border-danger-line bg-danger-wash text-danger not-disabled:hover:border-danger/40",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[12.5px]",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-11 px-3.5 text-[13px]",
};

/**
 * A button's look, for buttons and for links that act as one. Size and variant are options rather than classes to
 * pass in, because Tailwind orders two classes for one property by value, not by which came last.
 * A busy button isn't dimmed: it is doing what you asked, not refusing you.
 */
export function buttonClass({ variant = "ghost", size = "md" }: { variant?: Variant; size?: Size } = {}) {
  return `relative inline-flex items-center justify-center gap-2 rounded-[10px] transition-[background-color,border-color,color,opacity,scale] duration-150 not-disabled:active:scale-[0.97] disabled:not-aria-busy:opacity-50 ${SIZES[size]} ${VARIANTS[variant]}`;
}

/** `className` is for layout only (width, margins, flex). `busy` disables the button and shows a spinner over its label. */
export function Button({ variant, size, busy = false, disabled, className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: Size; busy?: boolean;
}) {
  return (
    <button {...props} disabled={disabled || busy} aria-busy={busy || undefined} className={`${buttonClass({ variant, size })} ${className}`}>
      {/* The label stays laid out under the spinner, so the button keeps its width and its name. */}
      <span className={`inline-flex items-center gap-2 transition-opacity duration-150 ${busy ? "opacity-0" : ""}`}>{children}</span>
      {busy && <span className="absolute inset-0 grid place-items-center"><Spinner /></span>}
    </button>
  );
}
