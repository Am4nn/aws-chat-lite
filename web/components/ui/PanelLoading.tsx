import { SkeletonRows } from "./Skeleton";

/** A panel's first load: rows shaped like its list, or after a failure, a way to try again. */
export function PanelLoading({ failed = false, onRetry, rows }: { failed?: boolean; onRetry?: () => void; rows?: number }) {
  if (!failed) return <SkeletonRows rows={rows} />;
  return (
    <div className="flex h-9 items-center justify-center text-text-3">
      <button onClick={onRetry} className="rounded-md px-2 py-1 text-[12.5px] transition-colors hover:bg-surface-2 hover:text-text">
        Couldn&apos;t load · <span className="text-text-2 underline underline-offset-2">Retry</span>
      </button>
    </div>
  );
}
