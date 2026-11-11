"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

export type Installation = { id: number; account: string; repos: string[] };
export type RepoPick = { installationId: number; repos: string[] };

/** The server's limit, checked here too so the admin learns it before saving. */
const MAX_REPOS = 20;

/** Repos come from one installation, so ticking one from another installation starts the pick over there. */
export function RepoPicker({ installations, initial, busy, onCancel, onSave }: {
  installations: Installation[]; initial?: RepoPick; busy: boolean; onCancel: () => void; onSave: (pick: RepoPick) => void;
}) {
  const [pick, setPick] = useState<RepoPick | null>(initial ? { installationId: initial.installationId, repos: initial.repos } : null);
  const tooMany = (pick?.repos.length ?? 0) > MAX_REPOS;

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
      <div className="flex items-center justify-end gap-2">
        {tooMany && <p role="status" className="mr-auto text-[12.5px] text-text-3">Pick up to {MAX_REPOS} repos.</p>}
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => pick && onSave(pick)} disabled={busy || !pick?.repos.length || tooMany}>{busy && <Spinner />}Save</Button>
      </div>
    </div>
  );
}
