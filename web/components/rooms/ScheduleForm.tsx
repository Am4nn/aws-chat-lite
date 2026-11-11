"use client";

import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { cadenceOfKind, HOUR_STEPS, WEEKDAYS } from "@/lib/client/schedules";
import type { Agent, Cadence, Chat, Schedule, Weekday } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { panelInput } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";

export type ScheduleInput = Pick<Schedule, "agentId" | "title" | "prompt" | "cadence" | "chatId">;

const MAX_PROMPT = 2000;
const KINDS: { kind: Cadence["kind"]; label: string }[] = [
  { kind: "hours", label: "Every few hours" }, { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" }, { kind: "weekly", label: "Every week" },
];

/** A new schedule, or changes to one. Its times are on the room's clock, which the panel names above. */
export function ScheduleForm({ initial, agents, chats, busy, onCancel, onSubmit }: {
  initial?: Schedule; agents: Agent[]; chats: Chat[]; busy: boolean; onCancel: () => void; onSubmit: (input: ScheduleInput) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [agentId, setAgentId] = useState(initial?.agentId ?? "agent");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [cadence, setCadence] = useState<Cadence>(initial?.cadence ?? { kind: "daily", time: "09:00" });
  const [chatId, setChatId] = useState(initial?.chatId ?? chats[0]?.chatId ?? "");
  const id = initial?.scheduleId ?? "new";
  const field = (name: string) => `schedule-${name}-${id}`;

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ agentId, title: title.trim(), prompt: prompt.trim(), cadence, chatId });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    // Handled here, so the phone overlay around the panel stays open.
    e.preventDefault();
    onCancel();
  }

  return (
    <form onSubmit={submit} onKeyDown={onKeyDown} className="flex flex-col gap-3 rounded-xl border border-line-strong bg-surface-2 p-3">
      <Labelled id={field("title")} label="Title">
        <input
          id={field("title")} autoFocus required maxLength={40} placeholder="Morning digest" value={title}
          onChange={(e) => setTitle(e.target.value)} className={`${panelInput} h-10`}
        />
      </Labelled>
      <Labelled id={field("agent")} label="Agent">
        <select id={field("agent")} value={agentId} onChange={(e) => setAgentId(e.target.value)} className={`${panelInput} h-10 font-mono`}>
          {agents.map((a) => <option key={a.agentId} value={a.agentId}>@{a.name}</option>)}
        </select>
      </Labelled>
      <Labelled id={field("prompt")} label="Prompt" aside={`${prompt.length}/${MAX_PROMPT}`}>
        <textarea
          id={field("prompt")} required rows={4} maxLength={MAX_PROMPT} placeholder="Summarise yesterday's new PRs and issues."
          value={prompt} onChange={(e) => setPrompt(e.target.value)} className={`${panelInput} resize-y py-2 leading-snug`}
        />
      </Labelled>
      <Labelled id={field("kind")} label="Runs">
        <select
          id={field("kind")} value={cadence.kind} onChange={(e) => setCadence((c) => cadenceOfKind(c, e.target.value as Cadence["kind"]))}
          className={`${panelInput} h-10`}
        >
          {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
      </Labelled>
      <CadenceFields cadence={cadence} field={field} onChange={setCadence} />
      <Labelled id={field("chat")} label="Post in">
        <select id={field("chat")} value={chatId} onChange={(e) => setChatId(e.target.value)} className={`${panelInput} h-10`}>
          {chats.map((c) => <option key={c.chatId} value={c.chatId}>#{c.name}</option>)}
        </select>
      </Labelled>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !title.trim() || !prompt.trim() || !chatId}>
          {busy && <Spinner />}{initial ? "Save" : "Create schedule"}
        </Button>
      </div>
    </form>
  );
}

function CadenceFields({ cadence: c, field, onChange }: { cadence: Cadence; field: (name: string) => string; onChange: (c: Cadence) => void }) {
  const time = c.kind !== "hours" && (
    <Labelled id={field("time")} label="At">
      <input
        id={field("time")} type="time" required value={c.time} onChange={(e) => e.target.value && onChange({ ...c, time: e.target.value })}
        className={`${panelInput} h-10 font-mono`}
      />
    </Labelled>
  );
  if (c.kind === "hours") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Labelled id={field("every")} label="Every">
          <select
            id={field("every")} value={c.every} onChange={(e) => onChange({ ...c, every: Number(e.target.value) as typeof c.every })}
            className={`${panelInput} h-10`}
          >
            {HOUR_STEPS.map((n) => <option key={n} value={n}>{n === 1 ? "hour" : `${n} hours`}</option>)}
          </select>
        </Labelled>
        <Labelled id={field("minute")} label="At minute">
          <input
            id={field("minute")} type="number" inputMode="numeric" min={0} max={59} required value={c.minute}
            onChange={(e) => onChange({ ...c, minute: Math.min(59, Math.max(0, Math.trunc(Number(e.target.value)))) })}
            className={`${panelInput} h-10 font-mono`}
          />
        </Labelled>
      </div>
    );
  }
  if (c.kind === "weekly") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Labelled id={field("day")} label="On">
          <select id={field("day")} value={c.day} onChange={(e) => onChange({ ...c, day: e.target.value as Weekday })} className={`${panelInput} h-10`}>
            {WEEKDAYS.map((w) => <option key={w.day} value={w.day}>{w.name}</option>)}
          </select>
        </Labelled>
        {time}
      </div>
    );
  }
  return time;
}

function Labelled({ id, label, aside, children }: { id: string; label: string; aside?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline">
        <label htmlFor={id} className="text-xs font-medium text-text-3">{label}</label>
        {aside && <span className="ml-auto font-mono text-[11px] tabular-nums text-text-3">{aside}</span>}
      </div>
      {children}
    </div>
  );
}
