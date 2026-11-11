"use client";

import { useContext, useState, type KeyboardEvent } from "react";
import { agentLabel, RoomAgentsContext } from "@/lib/client/agents";
import { bff, errorText } from "@/lib/client/bff";
import { slugName } from "@/lib/client/threads";
import { useThreads } from "@/lib/client/ThreadsProvider";
import type { ThreadSummary } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";

/**
 * The thread's number, name and agent; anyone can rename it in place. The new name shows while it saves, and a refusal
 * (most often the name being taken) puts the old one back with the server's reason.
 */
export function ThreadTitle({ thread: t }: { thread: ThreadSummary }) {
  const toast = useToast();
  const { apply } = useThreads();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const agent = agentLabel(t.agentId, useContext(RoomAgentsContext));

  async function save() {
    const name = draft?.replace(/^-+|-+$/g, "");
    setDraft(null);
    if (!name || name === t.name) return;
    setSaving(name);
    try {
      apply((await bff<{ thread: ThreadSummary }>(`/bff/api/rooms/${t.roomId}/threads/${t.threadId}`, { method: "PATCH", body: { name } })).thread);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") void save();
    if (e.key === "Escape") {
      e.preventDefault();
      setDraft(null);
    }
  }

  return (
    <h1 className="flex min-w-0 items-baseline gap-1.5 font-display text-lg font-bold">
      <span className="shrink-0 font-mono text-[13px] font-normal text-text-3">#{t.number}</span>
      {draft === null
        ? (
          <button
            onClick={() => setDraft(saving ?? t.name)}
            title="Rename thread"
            className="-mx-1 min-w-0 truncate rounded-md px-1 text-left transition-colors hover:bg-surface-2"
          >
            <span className="sr-only">Rename thread </span>
            {saving ?? t.name}
          </button>
        )
        : (
          <input
            autoFocus
            aria-label="Thread name"
            value={draft}
            maxLength={32}
            onChange={(e) => setDraft(slugName(e.target.value))}
            onKeyDown={onKeyDown}
            onBlur={() => setDraft(null)}
            onFocus={(e) => e.target.select()}
            style={{ width: `${Math.max(draft.length, 6) + 2}ch` }}
            className="-mx-1 min-w-0 max-w-[40vw] rounded-md border border-[#36403f] bg-ink px-1 outline-none"
          />
        )}
      <span className="shrink-0 font-mono text-[12.5px] font-normal text-text-3 max-sm:hidden">{agent}</span>
    </h1>
  );
}
