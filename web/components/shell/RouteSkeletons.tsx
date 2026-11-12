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

/** A turn's heading, its stats and time-share row, then the agent's lane with a few step cards. */
function MapSkeleton() {
  return (
    <Loading label="map">
      <Bar className="mx-4 mt-4 h-4 w-60 max-w-[60%] sm:mx-[22px]" />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-[22px]">
        <Bar className="h-4 w-56" />
        <Bar className="h-1.5 w-[200px] rounded-full max-sm:w-full sm:ml-auto" />
        <Bar className="h-8 w-[86px] rounded-[10px]" />
      </div>
      <div className="mx-4 flex h-[152px] gap-6 overflow-hidden rounded-2xl bg-surface-1 pl-[98px] pt-12">
        {[0, 1, 2].map((i) => <Bar key={i} className="h-[72px] w-[108px] shrink-0 rounded-xl" />)}
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
