"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FolderGit2, Hourglass, Pencil } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { formatWait } from "@/lib/client/format";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import { swap } from "@/lib/motion";
import type { GitHubConnection } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Hint";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";
import { ActivityLog } from "./ActivityLog";

type Connections = { github: GitHubConnection | null; approvalTimeoutMin: number; canManage: boolean; installUrl: string | null };
type Installation = { id: number; account: string; repos: string[] };
type RepoPick = { installationId: number; repos: string[] };
type Mode = { kind: "view" } | { kind: "confirmDisconnect" } | { kind: "pick"; installations: Installation[] | null };

/**
 * What the room's agent may reach and how long its writes wait, plus the room's activity log. Every member reads it;
 * admins change it. The server's answer is the truth, fetched again whenever the room changes.
 */
export function ConnectionsPanel({ roomId, archived }: { roomId: string; archived: boolean }) {
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
          ? <GitHubSection roomId={roomId} data={data} manage={manage} onChange={(github) => changed({ github })} />
          : <div className="flex h-9 items-center justify-center text-text-3"><Spinner /></div>}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="flex items-center text-[11.5px] font-semibold text-text-3">
          Approvals
          <Hint place="below" text="After this, the action is skipped and the run finishes with a note." />
        </h2>
        {data && <ApprovalTimeout roomId={roomId} minutes={data.approvalTimeoutMin} manage={manage} onChange={(approvalTimeoutMin) => changed({ approvalTimeoutMin })} />}
      </section>
      <ActivityLog roomId={roomId} version={version} />
    </div>
  );
}

function GitHubSection({ roomId, data, manage, onChange }: {
  roomId: string; data: Connections; manage: boolean; onChange: (github: GitHubConnection | null) => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [busy, setBusy] = useState(false);
  const { github, installUrl } = data;

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
              <Button onClick={startPicking} className="flex-1">Change repos</Button>
              <Button onClick={() => setMode({ kind: "confirmDisconnect" })}>Disconnect</Button>
            </div>
          ))}
          {installLink}
        </motion.div>
      ) : (
        <motion.div key="off" {...swap}>
          {manage
            ? <Button variant="primary" onClick={startPicking} className="w-full"><FolderGit2 aria-hidden="true" size={15} />Connect GitHub</Button>
            : <p className="text-[12.5px] text-text-3">Not connected</p>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Repos come from one installation, so ticking one from another installation starts the pick over there. */
function RepoPicker({ installations, initial, busy, onCancel, onSave }: {
  installations: Installation[]; initial?: RepoPick; busy: boolean; onCancel: () => void; onSave: (pick: RepoPick) => void;
}) {
  const [pick, setPick] = useState<RepoPick | null>(initial ? { installationId: initial.installationId, repos: initial.repos } : null);

  function toggle(installationId: number, repo: string) {
    setPick((p) => {
      if (p?.installationId !== installationId) return { installationId, repos: [repo] };
      const repos = p.repos.includes(repo) ? p.repos.filter((r) => r !== repo) : [...p.repos, repo];
      return { installationId, repos };
    });
  }

  if (installations.length === 0) return <p className="text-[12.5px] text-text-3">The App isn&apos;t installed on any account yet.</p>;

  return (
    <div className="flex flex-col gap-3">
      {installations.map((inst) => (
        <fieldset key={inst.id} className="flex flex-col">
          <legend className="mb-1 text-[11.5px] text-text-3">{inst.account}</legend>
          {inst.repos.map((repo) => (
            <label key={repo} className="flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-surface-2">
              <input
                type="checkbox"
                checked={pick?.installationId === inst.id && pick.repos.includes(repo)}
                onChange={() => toggle(inst.id, repo)}
                className="size-3.5 shrink-0 accent-lime"
              />
              <span className="truncate font-mono text-[12px] text-text-2">{repo}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => pick && onSave(pick)} disabled={busy || !pick?.repos.length}>{busy && <Spinner />}Save</Button>
      </div>
    </div>
  );
}

function ApprovalTimeout({ roomId, minutes, manage, onChange }: { roomId: string; minutes: number; manage: boolean; onChange: (minutes: number) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!draft?.trim() || Number(draft) === minutes) return setDraft(null);
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
    if (e.key === "Enter") void save();
    if (e.key === "Escape") {
      // Handled here, so the phone overlay around the panel stays open.
      e.preventDefault();
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
              onBlur={() => !saving && setDraft(null)}
              className="h-6 w-12 rounded-md border border-[#36403f] bg-ink px-1 text-right font-mono text-xs text-text tabular-nums outline-none disabled:opacity-60"
            />
            min
          </span>
        )}
      {manage && draft === null && (
        <button
          onClick={() => setDraft(String(minutes))}
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
