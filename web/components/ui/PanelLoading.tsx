import { Spinner } from "./Spinner";

/** A panel's first load: a spinner, or after a failure, a way to try again. Both take the same height, so nothing jumps. */
export function PanelLoading({ failed = false, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  return (
    <div className="flex h-9 items-center justify-center text-text-3">
      {failed
        ? (
          <button onClick={onRetry} className="rounded-md px-2 py-1 text-[12.5px] transition-colors hover:bg-surface-2 hover:text-text">
            Couldn&apos;t load · <span className="text-text-2 underline underline-offset-2">Retry</span>
          </button>
        )
        : <Spinner />}
    </div>
  );
}
