import { useId, type ReactNode } from "react";

/**
 * One section of a room panel tab: a quiet title row, then its body. The row holds the section's count, which callers
 * leave out while there is nothing to count, and its action (a New, an Upload), sized to fit the row unclipped.
 */
export function PanelSection({ title, count, action, children }: { title: string; count?: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2">
        <h2 id={id} className="text-[13px] font-medium">{title}</h2>
        {(count || action) && (
          <span className="ml-auto flex items-center gap-3">
            {count && <span className="font-mono text-[11.5px] tabular-nums text-text-3">{count}</span>}
            {action}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/** A tab's sections, split by hairlines with room on either side. */
export function PanelSections({ children }: { children: ReactNode }) {
  return <div className="flex flex-col divide-y divide-line [&>*]:py-5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-1">{children}</div>;
}

