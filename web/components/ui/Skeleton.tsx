/** A muted bar standing in for text or an avatar while the real thing loads. */
export function Bar({ className = "" }: { className?: string }) {
  return <div className={`rounded-md bg-surface-3 ${className}`} />;
}

/** Rows shaped like a panel's list rows (avatar, a line, a shorter line), so the list keeps its place as it loads. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-1 motion-safe:animate-pulse">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} data-skeleton-row className="flex min-h-12 items-center gap-3 px-1">
          <Bar className="size-7 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Bar className="h-3 w-2/3" />
            <Bar className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
