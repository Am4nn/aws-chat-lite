"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Copy, Link2, RefreshCw } from "lucide-react";
import { bff } from "@/lib/client/bff";
import { dur, easeOut } from "@/lib/motion";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";
import { expiresIn, inviteUrl } from "./invite";

type Invite = { code: string; expiresAt: number };
type State = { kind: "loading" } | { kind: "none" } | { kind: "active"; invite: Invite } | { kind: "confirmRevoke"; invite: Invite };

const fade = { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: { duration: dur.fast, ease: easeOut } };

/** One reusable link per room. Rotating replaces it (the old link stops working); revoking removes it. */
export function InvitePanel({ roomId }: { roomId: string }) {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bff<Invite>(`/bff/api/rooms/${roomId}/invite`)
      .then((invite) => setState({ kind: "active", invite }))
      .catch(() => setState({ kind: "none" }));
  }, [roomId]);

  async function run(action: () => Promise<State>) {
    setBusy(true);
    try {
      setState(await action());
    } finally {
      setBusy(false);
    }
  }

  const create = () => run(async () => ({ kind: "active", invite: await bff<Invite>(`/bff/api/rooms/${roomId}/invite`, { body: {} }) }));
  const revoke = () => run(async () => {
    await bff(`/bff/api/rooms/${roomId}/invite`, { method: "DELETE", body: {} });
    toast("Invite link revoked");
    return { kind: "none" };
  });
  const copy = async (invite: Invite) => {
    await navigator.clipboard.writeText(inviteUrl(window.location.origin, invite.code));
    toast("Invite link copied");
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] leading-relaxed text-text-3">Anyone with the link can join as a member for 7 days.</p>
      <AnimatePresence mode="wait" initial={false}>
        {state.kind === "loading" && (
          <motion.div key="loading" {...fade} className="flex h-20 items-center justify-center text-text-3"><Spinner /></motion.div>
        )}
        {state.kind === "none" && (
          <motion.div key="none" {...fade}>
            <Button variant="primary" onClick={create} disabled={busy} className="w-full">
              {busy ? <Spinner /> : <Link2 aria-hidden="true" size={15} />} Create invite link
            </Button>
          </motion.div>
        )}
        {(state.kind === "active" || state.kind === "confirmRevoke") && (
          <motion.div key={`link-${state.invite.code}`} {...fade} className="flex flex-col gap-3">
            <div className="rounded-xl border border-line-strong bg-surface-2 p-3">
              <p className="truncate font-mono text-[12px] text-text-2">/invite/{state.invite.code}</p>
              <p className="mt-1 text-[11.5px] text-text-3">Expires in {expiresIn(state.invite.expiresAt, Math.floor(Date.now() / 1000))}</p>
            </div>
            {state.kind === "active" ? (
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => copy(state.invite)} className="flex-1"><Copy aria-hidden="true" size={14} /> Copy link</Button>
                <Button onClick={create} disabled={busy} aria-label="Make a new link"><RefreshCw aria-hidden="true" size={14} /></Button>
                <Button onClick={() => setState({ kind: "confirmRevoke", invite: state.invite })}>Revoke</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl border border-[#4a2a26] bg-[#150f0e] p-3">
                <p className="text-[12.5px] text-[#ffb4aa]">Revoke this link? Anyone who hasn&apos;t joined yet can no longer use it.</p>
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setState({ kind: "active", invite: state.invite })}>Cancel</Button>
                  <Button variant="danger" onClick={revoke} disabled={busy}>{busy && <Spinner />}Revoke</Button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
