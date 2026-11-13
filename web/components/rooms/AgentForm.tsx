"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { BookOpen, Bot, ChevronRight, FolderGit2, Globe, ImageIcon, Megaphone, Server, SquareTerminal, type LucideIcon } from "lucide-react";
import { ROOM_KINDS } from "@/lib/client/agents";
import type { Agent, AgentModel, Delegates, ModelOption, ToolKind } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { panelInput } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";

export type AgentInput = { name: string; instructions: string; tools: ToolKind[]; model: AgentModel; delegates: Delegates };

export const TOOL_KINDS: { kind: ToolKind; label: string; icon: LucideIcon; missing?: string }[] = [
  { kind: "sandbox", label: "Sandbox", icon: SquareTerminal },
  { kind: "web", label: "Web", icon: Globe },
  { kind: "images", label: "Images", icon: ImageIcon },
  { kind: "github", label: "GitHub", icon: FolderGit2, missing: "Connect GitHub in Connections first." },
  { kind: "mcp", label: "MCP servers", icon: Server, missing: "Add an MCP server in Connections first." },
  { kind: "room_read", label: "Read room", icon: BookOpen },
  { kind: "room_post", label: "Post in channels", icon: Megaphone },
  { kind: "room_agents", label: "Manage agents", icon: Bot },
];

const MAX_INSTRUCTIONS = 4000;

/**
 * A new agent, or changes to one. Only the tool kinds the room offers can be ticked; a kind the agent already had
 * stays ticked when its connection goes, and comes back to life when it returns. The built-in @agent keeps its name.
 * A new agent starts without the room tools. `others` are the agents it may be allowed to hand work to.
 * `brief` is what every agent is told before its own instructions, shown so the box isn't mistaken for all of it.
 */
export function AgentForm({ initial, others, kinds, brief, models, busy, onCancel, onSubmit }: {
  initial?: Agent; others: Agent[]; kinds: ToolKind[]; brief: string; models: ModelOption[]; busy: boolean; onCancel: () => void; onSubmit: (input: AgentInput) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [tools, setTools] = useState<ToolKind[]>(initial?.tools ?? kinds.filter((k) => !ROOM_KINDS.includes(k)));
  const [delegates, setDelegates] = useState<Delegates>(initial?.delegates ?? "all");
  const [model, setModel] = useState<AgentModel>(initial?.model ?? "room");
  const id = initial?.agentId ?? "new";

  function submit(e: FormEvent) {
    e.preventDefault();
    // Agents deleted since stay in the stored list; sending only live ones keeps it within the server's cap.
    const live = delegates === "all" ? delegates : delegates.filter((d) => others.some((o) => o.agentId === d));
    onSubmit({ name: name.trim(), instructions, tools, model, delegates: live });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    // Handled here, so the phone overlay around the panel stays open.
    e.preventDefault();
    onCancel();
  }

  const toggle = (kind: ToolKind) => setTools((t) => (t.includes(kind) ? t.filter((k) => k !== kind) : [...t, kind]));

  const toggleDelegate = (agentId: string) => setDelegates((d) => {
    const list = d === "all" ? [] : d;
    return list.includes(agentId) ? list.filter((a) => a !== agentId) : [...list, agentId];
  });

  return (
    <form onSubmit={submit} onKeyDown={onKeyDown} className="flex flex-col gap-3 rounded-xl border border-line-strong bg-surface-2 p-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`agent-name-${id}`} className="text-xs font-medium text-text-3">Name</label>
        <div className="relative flex items-center">
          <span aria-hidden="true" className="pointer-events-none absolute left-3 font-mono text-[13px] text-text-3">@</span>
          <input
            id={`agent-name-${id}`} autoFocus={!initial} required maxLength={32} autoComplete="off" autoCapitalize="none" spellCheck={false}
            disabled={initial?.builtIn} value={name} onChange={(e) => setName(e.target.value.toLowerCase())}
            className={`${panelInput} h-10 w-full pl-7 font-mono`}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline">
          <label htmlFor={`agent-instructions-${id}`} className="text-xs font-medium text-text-3">Instructions</label>
          <span className="ml-auto font-mono text-[11px] tabular-nums text-text-3">{instructions.length}/{MAX_INSTRUCTIONS}</span>
        </div>
        <textarea
          id={`agent-instructions-${id}`} autoFocus={!!initial} rows={5} maxLength={MAX_INSTRUCTIONS}
          placeholder="What this agent is for, and how it should work."
          value={instructions} onChange={(e) => setInstructions(e.target.value)}
          className={`${panelInput} resize-y py-2 leading-snug`}
        />
        <details className="group text-[12.5px] text-text-3">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm transition-colors hover:text-text-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" size={13} className="transition-transform group-open:rotate-90" />
            Always included
          </summary>
          <p className="mt-1.5 rounded-lg bg-surface-1 px-2.5 py-2 leading-relaxed">{brief}</p>
        </details>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-text-3">Tools</legend>
        {TOOL_KINDS.map(({ kind, label, icon: Icon, missing }) => {
          const offered = kinds.includes(kind);
          return (
            <div key={kind} className="relative flex h-8 items-center gap-2 text-[13px]">
              <input
                id={`agent-${id}-${kind}`} type="checkbox" checked={tools.includes(kind)} disabled={!offered} onChange={() => toggle(kind)}
                className="size-4 accent-lime disabled:opacity-50"
              />
              <label htmlFor={`agent-${id}-${kind}`} className={`flex items-center gap-2 ${offered ? "text-text-2" : "text-text-3"}`}>
                <Icon aria-hidden="true" size={14} className="text-text-3" />
                {label}
              </label>
              {!offered && missing && <Hint below text={missing} />}
            </div>
          );
        })}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-text-3">Hands work to</legend>
        <div className="flex h-8 items-center gap-2 text-[13px]">
          <input
            id={`agent-${id}-delegates-all`} type="checkbox" checked={delegates === "all"} className="size-4 accent-lime"
            onChange={(e) => setDelegates(e.target.checked ? "all" : [])}
          />
          <label htmlFor={`agent-${id}-delegates-all`} className="text-text-2">Any agent</label>
        </div>
        {delegates !== "all" && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6">
            {others.map((o) => (
              <div key={o.agentId} className="flex h-8 min-w-0 items-center gap-2 text-[13px]">
                <input
                  id={`agent-${id}-delegates-${o.agentId}`} type="checkbox" checked={delegates.includes(o.agentId)}
                  onChange={() => toggleDelegate(o.agentId)} className="size-4 shrink-0 accent-lime"
                />
                <label htmlFor={`agent-${id}-delegates-${o.agentId}`} className="truncate font-mono text-text-2">@{o.name}</label>
              </div>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`agent-model-${id}`} className="text-xs font-medium text-text-3">Model</label>
        <select
          id={`agent-model-${id}`} value={model} onChange={(e) => setModel(e.target.value as AgentModel)}
          className={`${panelInput} h-10`}
        >
          <option value="room">Room default</option>
          {models.map((m) => <option key={m.pick} value={m.pick}>{m.label}</option>)}
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>{initial ? "Save" : "Create agent"}</Button>
      </div>
    </form>
  );
}
