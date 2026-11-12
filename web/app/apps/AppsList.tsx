"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { appLine } from "@/lib/client/apps";
import { bff, errorText } from "@/lib/client/bff";
import { removeOptimistically } from "@/lib/client/optimistic";
import { useNow } from "@/lib/client/useNow";
import { dur, easeOut, instant } from "@/lib/motion";
import type { McpApp } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Confirm } from "@/components/overlays/Confirm";
import { Modal } from "@/components/overlays/Modal";
import { useToast } from "@/components/overlays/Toast";

/** The apps signed in to my account. A removal shows on the tap and is undone if the server refuses. */
export function AppsList({ initial }: { initial: McpApp[] }) {
  const toast = useToast();
  const reduced = useReducedMotion();
  const now = useNow(false);
  const [apps, setApps] = useState(initial);
  const [removing, setRemoving] = useState<McpApp | null>(null);

  function remove(app: McpApp) {
    setRemoving(null);
    removeOptimistically({ list: apps, item: app, key: (a) => a.grantId, set: setApps }, () =>
      bff(`/bff/api/me/apps/${app.grantId}`, { method: "DELETE", body: {} })).catch((e) => toast(errorText(e), "error"));
  }

  return (
    <>
      {apps.length === 0 ? (
        <p className="mt-4 text-[13px] text-text-2">No apps have access.</p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-line">
          <AnimatePresence initial={false}>
            {apps.map((app) => (
              <motion.li
                key={app.grantId}
                exit={{ opacity: 0, height: 0 }}
                transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-3 py-3">
                  <p className="min-w-0 flex-1 break-words text-[13px] text-text-2">{appLine(app, now)}</p>
                  <Button onClick={() => setRemoving(app)} aria-label={`Remove ${app.clientName}`} className="shrink-0">Remove</Button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={removing ? `Remove ${removing.clientName}?` : ""}>
        {removing && <Confirm action="Remove" onCancel={() => setRemoving(null)} onConfirm={async () => remove(removing)}>It loses access at once.</Confirm>}
      </Modal>
    </>
  );
}
