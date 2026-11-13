"use client";

import { useRef, useState } from "react";
import { Ban, Check, Clock, Link2, MessageSquare, ShieldCheck, Timer, Unplug, Wrench, X, type LucideIcon } from "lucide-react";
import { auditLine, auditMayHaveChanged } from "@/lib/client/audit";
import { bff, errorText } from "@/lib/client/bff";
import { timeAgo } from "@/lib/client/format";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import { useNow } from "@/lib/client/useNow";
import type { AuditEntry, AuditKind, ThreadSummary } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { PanelSection } from "@/components/ui/PanelSection";
import { useToast } from "@/components/overlays/Toast";
import { useRoomData } from "./useRoomData";

type Page = { entries: AuditEntry[]; next?: string };

const ICONS: Record<AuditKind, LucideIcon> = {
  asked: MessageSquare, tool: Wrench, approved: Check, denied: X, expired: Clock, cancelled: Ban,
  connected: Link2, disconnected: Unplug, timeout: Timer, mode: ShieldCheck, cap: MessageSquare,
};

const CLOCK_TICK_MS = 60_000;

/**
 * The room's log, newest first. A new `version` (the room changed), or a run update that may carry entries of its
 * own (asked, approvals, tools), starts again from the newest page.
 */
export function ActivityLog({ roomId, version }: { roomId: string; version: number }) {
  const toast = useToast();
  const now = useNow(true, CLOCK_TICK_MS);
  const [loadingMore, setLoadingMore] = useState(false);
  const threads = useRef(new Map<string, ThreadSummary>());
  const path = `/bff/api/rooms/${roomId}/audit`;
  const { data: page, setData: setPage, failed, reload } = useRoomData<Page>(path, version);
  const next = page?.next;

  useLiveEvent("run.updated", (e) => {
    if (e.roomId !== roomId) return;
    if (auditMayHaveChanged(threads.current.get(e.thread.threadId), e.thread)) reload();
    threads.current.set(e.thread.threadId, e.thread);
  });

  async function loadMore(before: string) {
    setLoadingMore(true);
    try {
      const more = await bff<Page>(`${path}?before=${encodeURIComponent(before)}`);
      setPage((p) => ({ entries: [...(p?.entries ?? []), ...more.entries], next: more.next }));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PanelSection title="Activity">
      {!page && <PanelLoading failed={failed} onRetry={reload} />}
      {page?.entries.length === 0 && <p className="text-[12.5px] text-text-3">Nothing yet.</p>}
      {!!page?.entries.length && (
        <ul className="flex flex-col">
          {page.entries.map((e) => {
            const Icon = ICONS[e.kind];
            return (
              <li key={e.id} className="flex gap-2.5 py-1.5 text-[12.5px] leading-snug">
                <Icon aria-hidden="true" size={13} className="mt-[3px] shrink-0 text-text-3" />
                <span className="line-clamp-3 min-w-0 flex-1 text-text-2 [overflow-wrap:anywhere]">{auditLine(e)}</span>
                <time dateTime={e.at} className="shrink-0 whitespace-nowrap font-mono text-[11px] leading-[18px] text-text-3">{timeAgo(e.at, now)}</time>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <Button onClick={() => loadMore(next)} busy={loadingMore} className="w-full">Load more</Button>
      )}
    </PanelSection>
  );
}
