"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";

/** A confirm dialog's body: what will happen, then Cancel (focused, the safe choice) and the action. */
export function Confirm({ children, action, onCancel, onConfirm }: {
  children: ReactNode; action: string; onCancel: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="mb-5 text-[13.5px] leading-relaxed text-text-2">{children}</p>
      <div className="flex justify-end gap-2">
        <Button autoFocus onClick={onCancel}>Cancel</Button>
        <Button variant="danger" onClick={confirm} busy={busy}>{action}</Button>
      </div>
    </>
  );
}
