"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { FolderGit2, Globe, Server, SquareTerminal, type LucideIcon } from "lucide-react";
import type { Agent, AgentModel, ModelOption, ToolKind } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { panelInput } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Spinner } from "@/components/ui/Spinner";

export type AgentInput = { name: string; instructions: string; tools: ToolKind[]; model: AgentModel };

export const TOOL_KINDS: { kind: ToolKind; label: string; icon: LucideIcon; missing?: string }[] = [
  { kind: "sandbox", label: "Sandbox", icon: SquareTerminal },
  { kind: "web", label: "Web", icon: Globe },
  { kind: "github", label: "GitHub", icon: FolderGit2, missing: "Connect GitHub in Connections first." },
  { kind: "mcp", label: "MCP servers", icon: Server, missing: "Add an MCP server in Connections first." },
];

const MAX_INSTRUCTIONS = 4000;

/**
 * A new agent, or changes to one. Only the tool kinds the room offers can be ticked; a kind the agent already had
 * stays ticked when its connection goes, and comes back to life when it returns. The built-in @agent keeps its name.
 */
export function AgentForm({ initial, kinds, models, busy, onCancel, onSubmit }: {
  initial?: Agent; kinds: ToolKind[]; models: ModelOption[]; busy: boolean; onCancel: () => void; onSubmit: (input: AgentInput) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [tools, setTools] = useState<ToolKind[]>(initial?.tools ?? kinds);
  const [model, setModel] = useState<AgentModel>(initial?.model ?? "room");
  const id = initial?.agentId ?? "new";

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ name: name.trim(), instructions, tools, model });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    // Handled here, so the phone overlay around the panel stays open.
    e.preventDefault();
    onCancel();
  }

  const toggle = (kind: ToolKind) => setTools((t) => (t.includes(kind) ? t.filter((k) => k !== kind) : [...t, kind]));

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
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy && <Spinner />}{initial ? "Save" : "Create agent"}</Button>
      </div>
    </form>
  );
}
