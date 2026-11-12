"use client";

import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FolderGit2 } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { markFlowStarted } from "@/lib/client/flow-return";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import { swap } from "@/lib/motion";
import type { GitHubConnection, McpConnection } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { PanelSection } from "@/components/ui/PanelSection";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";
import { ActivityLog } from "./ActivityLog";
import { McpServers } from "./McpServers";
import { RepoPicker, type Installation, type RepoPick } from "./RepoPicker";
import { RoomSettings } from "./RoomSettings";
import { useRoomData } from "./useRoomData";

type Connections = {
  github: GitHubConnection | null; mcp: McpConnection[]; approvalTimeoutMin: number; canManage: boolean; installUrl: string | null;
};
type Mode = { kind: "view" } | { kind: "confirmDisconnect" } | { kind: "pick"; installations: Installation[] | null };

/**
 * The Room tab's Connections, Settings and Activity sections, which one answer from the server feeds: what the room's
 * agent may reach, how long its writes wait, and the room's log. Every member reads them; admins change them. The
 * server's answer is the truth, fetched again whenever the room changes. `pickGitHub`: the admin is back from GitHub's
 * sign-in, so the repo picker opens.
 */
export function ConnectionsPanel({ roomId, archived, pickGitHub, onPickStarted }: {
  roomId: string; archived: boolean; pickGitHub?: boolean; onPickStarted?: () => void;
}) {
  // One counter reloads both the connections and the activity log below them.
  const [version, setVersion] = useState(0);
  const { data, setData, failed, reload } = useRoomData<Connections>(`/bff/api/rooms/${roomId}/connections`, version);

  useLiveEvent("room.updated", (e) => {
    if (e.roomId === roomId) setVersion((v) => v + 1);
  });

  const parts = useRef<HTMLDivElement>(null);
  const manage = !!data?.canManage && !archived;
  /** Shown at once, then fetched again with the log, so this tab stays current even when its socket is down. */
  const changed = (patch: Partial<Connections>) => {
    setData((d) => d && { ...d, ...patch });
    setVersion((v) => v + 1);
  };

  // The Room tab opens on its files, so the picker, opening further down, is brought into view.
  const pickStarted = () => {
    parts.current?.scrollIntoView?.({ block: "start" });
    onPickStarted?.();
  };

  return (
    <>
      <PanelSection title="Connections">
        <div ref={parts} className="flex flex-col gap-5">
          <Part label="GitHub">
            {data
              ? (
                <GitHubSection
                  roomId={roomId} data={data} manage={manage} pick={!!pickGitHub} onPickStarted={pickStarted} onChange={(github) => changed({ github })}
                />
              )
              : <PanelLoading failed={failed} onRetry={reload} />}
          </Part>
          <Part label="MCP servers">
            {data
              ? <McpServers roomId={roomId} servers={data.mcp} manage={manage} onChange={(mcp) => changed({ mcp })} />
              : !failed && <PanelLoading />}
          </Part>
        </div>
      </PanelSection>
      <RoomSettings roomId={roomId} approvalTimeoutMin={data?.approvalTimeoutMin} manage={manage} onChange={(approvalTimeoutMin) => changed({ approvalTimeoutMin })} />
      <ActivityLog roomId={roomId} version={version} />
    </>
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-[11.5px] font-semibold text-text-3">{label}</h3>
      {children}
    </section>
  );
}

/**
 * An admin signs in with GitHub before picking repos, so the picker offers only installations and repos their own
 * GitHub account can reach.
 */
function GitHubSection({ roomId, data, manage, pick, onPickStarted, onChange }: {
  roomId: string; data: Connections; manage: boolean; pick: boolean; onPickStarted?: () => void; onChange: (github: GitHubConnection | null) => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [busy, setBusy] = useState(false);
  const { github, installUrl } = data;

  // Back from GitHub's sign-in: the picker opens once, and the room forgets the request so a later visit doesn't.
  const openPicker = useEffectEvent(() => {
    onPickStarted?.();
    void startPicking();
  });
  useEffect(() => {
    if (pick && manage) openPicker();
  }, [pick, manage]);

  /** The browser leaves for GitHub, so the spinner stays until the page goes. */
  async function signIn() {
    setBusy(true);
    try {
      const body = { redirectUri: `${window.location.origin}/bff/github/callback` };
      const { authorizeUrl } = await bff<{ authorizeUrl: string }>(`/bff/api/rooms/${roomId}/connections/github/sign-in`, { body });
      markFlowStarted();
      window.location.assign(authorizeUrl);
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  }

  async function startPicking() {
    setMode({ kind: "pick", installations: null });
    try {
      const { installations } = await bff<{ installations: Installation[] }>(`/bff/api/rooms/${roomId}/connections/github/installations`);
      setMode({ kind: "pick", installations });
    } catch (e) {
      toast(errorText(e), "error");
      setMode({ kind: "view" });
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      setMode({ kind: "view" });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const save = (pick: RepoPick) => run(async () => {
    const res = await bff<{ github: GitHubConnection }>(`/bff/api/rooms/${roomId}/connections/github`, { method: "PUT", body: pick });
    onChange(res.github);
    toast("GitHub connected");
  });
  const disconnect = () => run(async () => {
    await bff(`/bff/api/rooms/${roomId}/connections/github`, { method: "DELETE", body: {} });
    onChange(null);
    toast("GitHub disconnected");
  });

  const installLink = manage && installUrl && (
    <a href={installUrl} target="_blank" rel="noopener noreferrer" className="self-start rounded text-[12.5px] text-text-2 transition-colors hover:text-text">
      Add repos on GitHub ↗
    </a>
  );

  return (
    <AnimatePresence mode="wait" initial={false}>
      {mode.kind === "pick" ? (
        <motion.div key="pick" {...swap} className="flex flex-col gap-3">
          {mode.installations
            ? <RepoPicker installations={mode.installations} initial={github ?? undefined} busy={busy} onCancel={() => setMode({ kind: "view" })} onSave={save} />
            : <div className="flex h-20 items-center justify-center text-text-3"><Spinner /></div>}
          {installLink}
        </motion.div>
      ) : github ? (
        <motion.div key={`on-${github.addedAt}`} {...swap} className="flex flex-col gap-3">
          <div className="rounded-xl border border-line-strong bg-surface-2 p-3">
            <p className="flex items-center gap-2 text-[13px] font-medium"><FolderGit2 aria-hidden="true" size={14} className="text-text-3" />{github.account}</p>
            <ul aria-label="Repos" className="mt-2.5 flex flex-wrap gap-1.5">
              {github.repos.map((r) => (
                <li key={r} className="max-w-full truncate rounded-md bg-surface-4 px-1.5 py-0.5 font-mono text-[11.5px] text-text-2">{r}</li>
              ))}
            </ul>
          </div>
          {manage && (mode.kind === "confirmDisconnect" ? (
            <div className="flex flex-col gap-2 rounded-xl border border-danger-line bg-danger-wash p-3">
              <p className="text-[12.5px] text-danger">Disconnect GitHub? The room&apos;s agent loses these repos.</p>
              <div className="flex justify-end gap-2">
                <Button autoFocus onClick={() => setMode({ kind: "view" })}>Cancel</Button>
                <Button variant="danger" onClick={disconnect} busy={busy}>Disconnect</Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button onClick={signIn} busy={busy} className="flex-1">Change repos</Button>
              <Button onClick={() => setMode({ kind: "confirmDisconnect" })}>Disconnect</Button>
            </div>
          ))}
          {installLink}
        </motion.div>
      ) : (
        <motion.div key="off" {...swap}>
          {manage
            ? (
              <Button variant="primary" onClick={signIn} busy={busy} className="w-full">
                <FolderGit2 aria-hidden="true" size={15} />Connect GitHub
              </Button>
            )
            : <p className="text-[12.5px] text-text-3">Not connected</p>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
