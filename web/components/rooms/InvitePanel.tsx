"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Copy, Link2, RefreshCw } from "lucide-react";
import { bff, bffOrNull, errorText } from "@/lib/client/bff";
import { swap } from "@/lib/motion";
import { Button } from "@/components/ui/Button";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";
import { expiresIn, inviteUrl } from "./invite";

type Invite = { code: string; expiresAt: number };
type State =
  | { kind: "loading" } | { kind: "failed" } | { kind: "none" } | { kind: "active"; invite: Invite } | { kind: "confirmRevoke"; invite: Invite };

/**
 * One reusable link per room. Rotating replaces it (the old link stops working); revoking removes it. A room with no
 * link answers 404, which is "none"; any other failed load offers a retry, since saying "no link" then would be wrong.
 */
export function InvitePanel({ roomId }: { roomId: string }) {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    bffOrNull<Invite>(`/bff/api/rooms/${roomId}/invite`).then(
      (invite) => current && setState(invite ? { kind: "active", invite } : { kind: "none" }),
      (e) => {
        if (!current) return;
        toast(errorText(e), "error");
        setState({ kind: "failed" });
      },
    );
    return () => { current = false; };
  }, [roomId, attempt, toast]);

  const retry = () => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  async function run(action: () => Promise<State>) {
    setBusy(true);
    try {
      setState(await action());
    } catch (e) {
      toast(errorText(e), "error");
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
        {(state.kind === "loading" || state.kind === "failed") && (
          <motion.div key="loading" {...swap}><PanelLoading failed={state.kind === "failed"} onRetry={retry} /></motion.div>
        )}
        {state.kind === "none" && (
          <motion.div key="none" {...swap}>
            <Button variant="primary" onClick={create} disabled={busy} className="w-full">
              {busy ? <Spinner /> : <Link2 aria-hidden="true" size={15} />} Create invite link
            </Button>
          </motion.div>
        )}
        {(state.kind === "active" || state.kind === "confirmRevoke") && (
          <motion.div key={`link-${state.invite.code}`} {...swap} className="flex flex-col gap-3">
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
              <div className="flex flex-col gap-2 rounded-xl border border-danger-line bg-danger-wash p-3">
                <p className="text-[12.5px] text-danger">Revoke this link? Anyone who hasn&apos;t joined yet can no longer use it.</p>
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
