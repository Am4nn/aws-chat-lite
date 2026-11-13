"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Hourglass, MessageSquare, Pencil, ShieldCheck } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { APPROVAL_MODES } from "@/lib/client/approval-mode";
import { formatWait } from "@/lib/client/format";
import type { ApprovalMode } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { Hint } from "@/components/ui/Hint";
import { PanelSection } from "@/components/ui/PanelSection";
import { Bar } from "@/components/ui/Skeleton";

const MODE_HINT = APPROVAL_MODES.map((m) => m.title).join(" ");

/**
 * How the room behaves: how much an agent may do without a member's approval, how many times it posts in a run, and
 * how long its writes wait. Admins change them; members see them. The values are undefined until the room's
 * connections have loaded.
 */
export function RoomSettings({ roomId, approvalTimeoutMin, approvalMode, postCap, manage, onChange, onModeChange, onCapChange }: {
  roomId: string; approvalTimeoutMin?: number; approvalMode?: ApprovalMode; postCap?: number; manage: boolean;
  onChange: (minutes: number) => void; onModeChange: (mode: ApprovalMode) => void; onCapChange: (cap: number) => void;
}) {
  const toast = useToast();

  async function setMode(mode: ApprovalMode) {
    try {
      const res = await bff<{ approvalMode: ApprovalMode }>(`/bff/api/rooms/${roomId}/approval-mode`, { method: "PUT", body: { mode } });
      onModeChange(res.approvalMode);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  return (
    <PanelSection title="Settings">
      {approvalTimeoutMin === undefined || approvalMode === undefined || postCap === undefined
        ? <Bar className="h-10 rounded-xl motion-safe:animate-pulse" />
        : (
          <div className="flex flex-col gap-2">
            <ModeRow mode={approvalMode} manage={manage} onPick={(mode) => void setMode(mode)} />
            <NumberRow
              icon={<MessageSquare aria-hidden="true" size={13} className="shrink-0 text-text-3" />} before="Agents post up to" after="times a run"
              view={postCap} value={postCap} manage={manage} inputLabel="Post cap per run, 1 to 50" editLabel="Change the post cap"
              onSave={async (cap) => {
                const res = await bff<{ postCap: number }>(`/bff/api/rooms/${roomId}/post-cap`, { method: "PUT", body: { cap } });
                onCapChange(res.postCap);
              }}
            />
            <NumberRow
              icon={<Hourglass aria-hidden="true" size={13} className="shrink-0 text-text-3" />} before="Writes wait" after="min" suffix="for approval"
              view={formatWait(approvalTimeoutMin * 60)} value={approvalTimeoutMin} manage={manage}
              inputLabel="Approval timeout in minutes, 5 to 1440" editLabel="Change the approval timeout"
              hint="After this, the action is skipped and the run finishes with a note."
              onSave={async (minutes) => {
                const res = await bff<{ approvalTimeoutMin: number }>(`/bff/api/rooms/${roomId}/approval-timeout`, { method: "PUT", body: { minutes } });
                onChange(res.approvalTimeoutMin);
              }}
            />
          </div>
        )}
    </PanelSection>
  );
}

function ModeRow({ mode, manage, onPick }: { mode: ApprovalMode; manage: boolean; onPick: (mode: ApprovalMode) => void }) {
  return (
    <div className="relative flex h-10 items-center gap-2 rounded-xl bg-surface-2 px-3 text-[12.5px] text-text-2">
      <ShieldCheck aria-hidden="true" size={13} className="shrink-0 text-text-3" />
      <span className="truncate">Agent approvals</span>
      <Hint below text={MODE_HINT} />
      <div role="group" aria-label="Agent approvals" className="-mr-1.5 ml-auto flex shrink-0 gap-0.5 rounded-lg bg-surface-3 p-0.5">
        {APPROVAL_MODES.map((m) => (
          <button
            key={m.mode}
            disabled={!manage}
            aria-pressed={m.mode === mode}
            onClick={() => m.mode !== mode && onPick(m.mode)}
            className={`h-6 rounded-md px-2 text-xs transition-colors disabled:cursor-default ${
              m.mode === mode ? "bg-surface-4 font-medium text-text" : "text-text-3 enabled:hover:text-text"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A sentence with one number in it, which an admin edits in place: `before`, the number, then `after`. `view`: how
 * the number reads while it isn't being edited; `suffix` replaces `after` then, for a sentence that reads differently
 * beside a field than beside a formatted value.
 */
function NumberRow({ icon, before, after, suffix, view, value, manage, inputLabel, editLabel, hint, onSave }: {
  icon: ReactNode; before: string; after: string; suffix?: string; view: ReactNode; value: number; manage: boolean;
  inputLabel: string; editLabel: string; hint?: string; onSave: (value: number) => Promise<void>;
}) {
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
    if (cancelled.current || !draft?.trim() || Number(draft) === value) return setDraft(null);
    setSaving(true);
    try {
      await onSave(Number(draft));
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
      {icon}
      {draft === null
        ? (
          <>
            <span>{before} <span className="font-medium text-text">{view}</span> {suffix ?? after}</span>
            {hint && <Hint below text={hint} />}
          </>
        )
        : (
          <span className="flex items-center gap-1.5">
            {before}
            <input
              autoFocus
              aria-label={inputLabel}
              inputMode="numeric"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
              onKeyDown={onKeyDown}
              onBlur={() => void save()}
              className="h-6 w-12 rounded-md border border-line-hover bg-ink px-1 text-right font-mono text-xs text-text tabular-nums outline-none disabled:opacity-60"
            />
            {after}
          </span>
        )}
      {manage && draft === null && (
        <button
          onClick={() => {
            cancelled.current = false;
            setDraft(String(value));
          }}
          aria-label={editLabel}
          title={editLabel}
          className="-mr-1.5 ml-auto grid size-6 place-items-center rounded-md text-text-3 transition-[background-color,color,scale] hover:bg-surface-3 hover:text-text active:scale-90"
        >
          <Pencil aria-hidden="true" size={12} />
        </button>
      )}
    </div>
  );
}
