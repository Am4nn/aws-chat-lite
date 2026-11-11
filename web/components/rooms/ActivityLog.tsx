"use client";

import { useEffect, useState } from "react";
import { Ban, Check, Clock, Link2, MessageSquare, Timer, Unplug, Wrench, X, type LucideIcon } from "lucide-react";
import { auditLine } from "@/lib/client/audit";
import { bff, errorText } from "@/lib/client/bff";
import { timeAgo } from "@/lib/client/format";
import { useNow } from "@/lib/client/useNow";
import type { AuditEntry, AuditKind } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";

type Page = { entries: AuditEntry[]; next?: string };

const ICONS: Record<AuditKind, LucideIcon> = {
  asked: MessageSquare, tool: Wrench, approved: Check, denied: X, expired: Clock, cancelled: Ban,
  connected: Link2, disconnected: Unplug, timeout: Timer,
};

const CLOCK_TICK_MS = 60_000;

/** The room's log, newest first. A new `version` (the room changed) starts again from the newest page. */
export function ActivityLog({ roomId, version }: { roomId: string; version: number }) {
  const toast = useToast();
  const now = useNow(true, CLOCK_TICK_MS);
  const [page, setPage] = useState<Page | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const path = `/bff/api/rooms/${roomId}/audit`;
  const next = page?.next;

  useEffect(() => {
    let current = true;
    bff<Page>(path)
      .then((p) => current && setPage(p))
      .catch((e) => toast(errorText(e), "error"));
    return () => { current = false; };
  }, [path, version, toast]);

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
    <section className="flex flex-col gap-2">
      <h2 className="text-[11.5px] font-semibold text-text-3">Activity</h2>
      {!page && <div className="flex h-9 items-center justify-center text-text-3"><Spinner /></div>}
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
        <Button onClick={() => loadMore(next)} disabled={loadingMore} className="w-full">{loadingMore && <Spinner />}Load more</Button>
      )}
    </section>
  );
}
