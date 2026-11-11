"use client";

import { useState, type KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { budgetFill, formatUsd, resetsOn } from "@/lib/client/format";
import { useThreads } from "@/lib/client/ThreadsProvider";
import type { Budget } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";

/**
 * What the room's agents have spent this month against its cap. This is the app's only progress bar: money is the
 * one thing with a known total. The owner edits the cap in place.
 */
export function BudgetCard({ roomId, isOwner }: { roomId: string; isOwner: boolean }) {
  const toast = useToast();
  const { budget, setBudget } = useThreads();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fill = budgetFill(budget);

  async function save() {
    const capUsd = Number(draft);
    if (!draft?.trim() || Number.isNaN(capUsd)) return setDraft(null);
    setSaving(true);
    try {
      setBudget((await bff<{ budget: Budget }>(`/bff/api/rooms/${roomId}/budget`, { method: "PUT", body: { capUsd } })).budget);
      setDraft(null);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") void save();
    if (e.key === "Escape") {
      // Handled here, so the phone drawer around the sidebar stays open.
      e.preventDefault();
      setDraft(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="flex h-6 items-center gap-1 whitespace-nowrap text-xs text-text-2">
        Room budget
        <ResetHint resetsAt={budget.resetsAt} />
        <span className="ml-auto" />
        <span className="font-mono text-text tabular-nums">{formatUsd(budget.spentMicros)}</span>
        <span className="font-mono text-text-3">/</span>
        {draft === null
          ? <span className="font-mono text-text-3 tabular-nums">{formatUsd(budget.capMicros)}</span>
          : (
            <span className="flex items-center font-mono text-text">
              $
              <input
                autoFocus
                aria-label="Monthly cap in dollars, up to $20"
                inputMode="decimal"
                value={draft}
                disabled={saving}
                onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ""))}
                onKeyDown={onKeyDown}
                onBlur={() => !saving && setDraft(null)}
                className="h-6 w-12 rounded-md border border-[#36403f] bg-ink px-1 text-right text-xs tabular-nums outline-none disabled:opacity-60"
              />
            </span>
          )}
        {isOwner && draft === null && (
          <button
            onClick={() => setDraft((budget.capMicros / 1_000_000).toFixed(2))}
            aria-label="Change the monthly cap"
            title="Change the monthly cap"
            className="-mr-1.5 grid size-6 place-items-center rounded-md text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90"
          >
            <Pencil aria-hidden="true" size={12} />
          </button>
        )}
      </div>
      <span className="block h-1 overflow-hidden rounded-full bg-[#1c2225]">
        <span
          className={`block h-1 rounded-full transition-[width,background-color] duration-500 ease-[cubic-bezier(.2,.9,.2,1)] motion-reduce:transition-none ${fill >= 100 ? "bg-amber" : "bg-lime"}`}
          style={{ width: `${fill}%` }}
        />
      </span>
    </div>
  );
}

/**
 * A "?" that explains the reset on hover or focus, keeping the card to one line of text. The mark is drawn small, but
 * the button around it is a full 24 px target.
 */
function ResetHint({ resetsAt }: { resetsAt: string }) {
  const text = `Resets on ${resetsOn(resetsAt)} (00:00 UTC)`;
  return (
    <span className="group relative ml-0.5 flex">
      <button aria-label={text} className="-mx-1 grid size-6 place-items-center rounded-full">
        <span
          aria-hidden="true"
          className="grid size-4 place-items-center rounded-full border border-line-strong font-mono text-[10px] leading-none text-text-3 transition-colors group-hover:border-[#36403f] group-hover:text-text-2"
        >
          ?
        </span>
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line-strong bg-surface-3 px-2.5 py-1.5 text-[11.5px] text-text-2 opacity-0 shadow-[0_8px_24px_rgba(0,0,0,.4)] transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
