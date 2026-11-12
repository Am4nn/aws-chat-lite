import type { ReactNode } from "react";
import type { SkeletonKind } from "@/lib/client/navTarget";
import { Bar } from "@/components/ui/Skeleton";

// One skeleton per room page, shared by its loading.tsx and the room shell's tap feedback, so the two never drift.
// Each mirrors its page's column, paddings and composer, so nothing moves when the real page lands.

function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div aria-busy="true" aria-label={`Loading ${label}`} className="flex h-full flex-col motion-safe:animate-pulse">
      {children}
    </div>
  );
}

/** The composer's box at its resting height: a 38 px row inside an 8 px padding and a hairline border. */
function ComposerSkeleton() {
  return (
    <div data-composer className="mx-auto w-full max-w-[836px] px-4 pb-5 sm:px-7">
      <div className="flex justify-end rounded-2xl border border-line-strong bg-surface-2 p-2">
        <Bar className="size-[38px] rounded-[11px]" />
      </div>
    </div>
  );
}

/** The typing line keeps its height even when nobody is typing. */
const TypingSpace = () => <div className="h-6 shrink-0" />;

function MessageSkeleton({ lines }: { lines: string[] }) {
  return (
    <div className="flex gap-3 px-3">
      <Bar className="size-8 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <Bar className="h-3 w-28" />
        {lines.map((w, i) => <Bar key={i} className={`h-3.5 ${w}`} />)}
      </div>
    </div>
  );
}

/** Messages sit at the bottom, where the list sticks, above the typing line and the composer. */
export function ChatSkeleton() {
  return (
    <Loading label="chat">
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        <div className="mx-auto flex w-full max-w-[836px] flex-col gap-5 px-4 pb-2 pt-6 sm:px-7">
          <MessageSkeleton lines={["w-3/5"]} />
          <MessageSkeleton lines={["w-4/5", "w-2/5"]} />
          <MessageSkeleton lines={["w-1/2"]} />
        </div>
      </div>
      <TypingSpace />
      <ComposerSkeleton />
    </Loading>
  );
}

/** The thread's intro line, the message that started it (right-aligned, like a sent bubble), then its run. */
export function ThreadSkeleton() {
  return (
    <Loading label="thread">
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-[836px] flex-col gap-[18px] px-4 pb-4 pt-[26px] sm:px-7">
          <div className="flex items-center gap-3 pb-1">
            <Bar className="size-8 shrink-0 rounded-[10px]" />
            <Bar className="h-3.5 w-72 max-w-[60%]" />
          </div>
          <Bar className="h-11 w-[min(340px,70%)] self-end rounded-[16px_16px_6px_16px]" />
          <div className="flex flex-col gap-2.5">
            <Bar className="h-8 w-40 rounded-lg" />
            <Bar className="h-3.5 w-full" />
            <Bar className="h-3.5 w-5/6" />
            <Bar className="h-3.5 w-2/3" />
          </div>
        </div>
      </div>
      <TypingSpace />
      <ComposerSkeleton />
    </Loading>
  );
}

/** The totals strip, then the newest turn's row: its prompt block and a few step cards level with its middle. */
function MapSkeleton() {
  return (
    <Loading label="map">
      <div className="flex h-11 shrink-0 items-center gap-4 border-b border-line px-4 sm:px-[22px]">
        <Bar className="h-3.5 w-40" />
        <Bar className="h-1 w-[140px] rounded-full" />
      </div>
      <div className="flex overflow-hidden px-4 pt-6 sm:px-[22px]">
        <Bar className="h-24 w-52 shrink-0 rounded-xl" />
        <div className="flex gap-4 pl-6 pt-3">
          {[0, 1, 2].map((i) => <Bar key={i} className="h-[72px] w-[128px] shrink-0 rounded-xl" />)}
        </div>
      </div>
    </Loading>
  );
}

/** The empty thread's avatar, title and line, then the composer. */
export function NewThreadSkeleton() {
  return (
    <Loading label="new thread">
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-[836px] flex-col gap-1.5 px-4 pb-4 pt-10 sm:px-7">
          <Bar className="mb-2.5 size-12 rounded-[14px]" />
          <Bar className="h-7 w-44" />
          <Bar className="h-4 w-3/4" />
        </div>
      </div>
      <ComposerSkeleton />
    </Loading>
  );
}

export const ROUTE_SKELETONS: Record<SkeletonKind, () => ReactNode> = {
  chat: ChatSkeleton,
  thread: ThreadSkeleton,
  map: MapSkeleton,
  "new-thread": NewThreadSkeleton,
};
