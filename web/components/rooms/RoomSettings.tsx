"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Hourglass, Pencil } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { formatWait } from "@/lib/client/format";
import { useToast } from "@/components/overlays/Toast";
import { Hint } from "@/components/ui/Hint";
import { PanelSection } from "@/components/ui/PanelSection";
import { Bar } from "@/components/ui/Skeleton";

/**
 * How the room behaves: for now, how long an agent's writes wait for a member's approval. Admins change it; members
 * see it. `approvalTimeoutMin` is undefined until the room's connections have loaded.
 */
export function RoomSettings({ roomId, approvalTimeoutMin, manage, onChange }: {
  roomId: string; approvalTimeoutMin?: number; manage: boolean; onChange: (minutes: number) => void;
}) {
  return (
    <PanelSection title="Settings">
      {approvalTimeoutMin === undefined
        ? <Bar className="h-10 rounded-xl motion-safe:animate-pulse" />
        : <ApprovalTimeout roomId={roomId} minutes={approvalTimeoutMin} manage={manage} onChange={onChange} />}
    </PanelSection>
  );
}

function ApprovalTimeout({ roomId, minutes, manage, onChange }: { roomId: string; minutes: number; manage: boolean; onChange: (minutes: number) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set by Escape, so the blur that follows doesn't save what was just cancelled.
  const cancelled = useRef(false);

  /**
   * Saves on blur, which is how the field is left on a phone: iOS shows a number pad with no return key, and its Done
   * button blurs the field. Enter blurs too, so there is one way to save.
   */
  async function save() {
    if (cancelled.current || !draft?.trim() || Number(draft) === minutes) return setDraft(null);
    setSaving(true);
    try {
      const res = await bff<{ approvalTimeoutMin: number }>(`/bff/api/rooms/${roomId}/approval-timeout`, { method: "PUT", body: { minutes: Number(draft) } });
      onChange(res.approvalTimeoutMin);
      setDraft(null);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      // Handled here, so the phone overlay around the panel stays open.
      e.preventDefault();
      cancelled.current = true;
      setDraft(null);
    }
  }

  return (
    <div className="relative flex h-10 items-center gap-2 rounded-xl bg-surface-2 px-3 text-[12.5px] text-text-2">
      <Hourglass aria-hidden="true" size={13} className="shrink-0 text-text-3" />
      {draft === null
        ? (
          <>
            <span>Writes wait <span className="font-medium text-text">{formatWait(minutes * 60)}</span> for approval</span>
            <Hint below text="After this, the action is skipped and the run finishes with a note." />
          </>
        )
        : (
          <span className="flex items-center gap-1.5">
            Writes wait
            <input
              autoFocus
              aria-label="Approval timeout in minutes, 5 to 1440"
              inputMode="numeric"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
              onKeyDown={onKeyDown}
              onBlur={() => void save()}
              className="h-6 w-12 rounded-md border border-line-hover bg-ink px-1 text-right font-mono text-xs text-text tabular-nums outline-none disabled:opacity-60"
            />
            min
          </span>
        )}
      {manage && draft === null && (
        <button
          onClick={() => {
            cancelled.current = false;
            setDraft(String(minutes));
          }}
          aria-label="Change the approval timeout"
          title="Change the approval timeout"
          className="-mr-1.5 ml-auto grid size-6 place-items-center rounded-md text-text-3 transition-[background-color,color,scale] hover:bg-surface-3 hover:text-text active:scale-90"
        >
          <Pencil aria-hidden="true" size={12} />
        </button>
      )}
    </div>
  );
}
