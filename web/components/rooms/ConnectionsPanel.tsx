"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FolderGit2, Hourglass, Pencil } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { formatWait } from "@/lib/client/format";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import { swap } from "@/lib/motion";
import type { GitHubConnection, McpConnection } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Hint";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";
import { ActivityLog } from "./ActivityLog";
import { McpServers } from "./McpServers";
import { RepoPicker, type Installation, type RepoPick } from "./RepoPicker";

type Connections = {
  github: GitHubConnection | null; mcp: McpConnection[]; approvalTimeoutMin: number; canManage: boolean; installUrl: string | null;
};
type Mode = { kind: "view" } | { kind: "confirmDisconnect" } | { kind: "pick"; installations: Installation[] | null };

/**
 * What the room's agent may reach and how long its writes wait, plus the room's activity log. Every member reads it;
 * admins change it. The server's answer is the truth, fetched again whenever the room changes. `pickGitHub`: the
 * admin is back from GitHub's sign-in, so the repo picker opens.
 */
export function ConnectionsPanel({ roomId, archived, pickGitHub, onPickStarted }: {
  roomId: string; archived: boolean; pickGitHub?: boolean; onPickStarted?: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<Connections | null>(null);
  const [version, setVersion] = useState(0);

  useLiveEvent("room.updated", (e) => {
    if (e.roomId === roomId) setVersion((v) => v + 1);
  });

  useEffect(() => {
    let current = true;
    bff<Connections>(`/bff/api/rooms/${roomId}/connections`)
      .then((d) => current && setData(d))
      .catch((e) => toast(errorText(e), "error"));
    return () => { current = false; };
  }, [roomId, version, toast]);

  const manage = !!data?.canManage && !archived;
  /** Shown at once, then fetched again with the log, so this tab stays current even when its socket is down. */
  const changed = (patch: Partial<Connections>) => {
    setData((d) => d && { ...d, ...patch });
    setVersion((v) => v + 1);
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-[11.5px] font-semibold text-text-3">GitHub</h2>
        {data
          ? (
            <GitHubSection
              roomId={roomId} data={data} manage={manage} pick={!!pickGitHub} onPickStarted={onPickStarted} onChange={(github) => changed({ github })}
            />
          )
          : <div className="flex h-9 items-center justify-center text-text-3"><Spinner /></div>}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-[11.5px] font-semibold text-text-3">MCP servers</h2>
        {data
          ? <McpServers roomId={roomId} servers={data.mcp} manage={manage} onChange={(mcp) => changed({ mcp })} />
          : <div className="flex h-9 items-center justify-center text-text-3"><Spinner /></div>}
      </section>
      <section className="flex flex-col gap-2">
        {/* The hint sits beside the heading, not in it, so the heading's accessible name is just "Approvals". */}
        <div className="relative flex items-center">
          <h2 className="text-[11.5px] font-semibold text-text-3">Approvals</h2>
          <Hint below text="After this, the action is skipped and the run finishes with a note." />
        </div>
        {data && <ApprovalTimeout roomId={roomId} minutes={data.approvalTimeoutMin} manage={manage} onChange={(approvalTimeoutMin) => changed({ approvalTimeoutMin })} />}
      </section>
      <ActivityLog roomId={roomId} version={version} />
    </div>
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
  useEffect(() => {
    if (!pick || !manage) return;
    onPickStarted?.();
    void startPicking();
  }, [pick, manage]);

  /** The browser leaves for GitHub, so the spinner stays until the page goes. */
  async function signIn() {
    setBusy(true);
    try {
      const body = { redirectUri: `${window.location.origin}/bff/github/callback` };
      window.location.assign((await bff<{ authorizeUrl: string }>(`/bff/api/rooms/${roomId}/connections/github/sign-in`, { body })).authorizeUrl);
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
                <li key={r} className="max-w-full truncate rounded-md bg-[#1a2023] px-1.5 py-0.5 font-mono text-[11.5px] text-text-2">{r}</li>
              ))}
            </ul>
          </div>
          {manage && (mode.kind === "confirmDisconnect" ? (
            <div className="flex flex-col gap-2 rounded-xl border border-[#4a2a26] bg-[#150f0e] p-3">
              <p className="text-[12.5px] text-[#ffb4aa]">Disconnect GitHub? The room&apos;s agent loses these repos.</p>
              <div className="flex justify-end gap-2">
                <Button autoFocus onClick={() => setMode({ kind: "view" })}>Cancel</Button>
                <Button variant="danger" onClick={disconnect} disabled={busy}>{busy && <Spinner />}Disconnect</Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button onClick={signIn} disabled={busy} className="flex-1">{busy && <Spinner />}Change repos</Button>
              <Button onClick={() => setMode({ kind: "confirmDisconnect" })}>Disconnect</Button>
            </div>
          ))}
          {installLink}
        </motion.div>
      ) : (
        <motion.div key="off" {...swap}>
          {manage
            ? (
              <Button variant="primary" onClick={signIn} disabled={busy} className="w-full">
                {busy ? <Spinner /> : <FolderGit2 aria-hidden="true" size={15} />}Connect GitHub
              </Button>
            )
            : <p className="text-[12.5px] text-text-3">Not connected</p>}
        </motion.div>
      )}
    </AnimatePresence>
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
    <div className="flex h-10 items-center gap-2 rounded-xl bg-surface-2 px-3 text-[12.5px] text-text-2">
      <Hourglass aria-hidden="true" size={13} className="shrink-0 text-text-3" />
      {draft === null
        ? <span>Writes wait <span className="font-medium text-text">{formatWait(minutes * 60)}</span> for approval</span>
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
              className="h-6 w-12 rounded-md border border-[#36403f] bg-ink px-1 text-right font-mono text-xs text-text tabular-nums outline-none disabled:opacity-60"
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
          className="-mr-1.5 ml-auto grid size-6 place-items-center rounded-md text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90"
        >
          <Pencil aria-hidden="true" size={12} />
        </button>
      )}
    </div>
  );
}
