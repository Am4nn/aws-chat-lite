"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOut } from "@/lib/client/signOut";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function leave() {
    setBusy(true);
    await signOut();
    router.replace("/login");
  }

  return (
    <button
      onClick={leave} disabled={busy}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-[0.97] disabled:opacity-60"
    >
      <LogOut aria-hidden="true" size={14} />
      Sign out
    </button>
  );
}
