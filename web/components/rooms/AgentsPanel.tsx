"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { canEditAgent, copyTargets, copyToast, type CopyResult } from "@/lib/client/agents";
import { bff, errorText } from "@/lib/client/bff";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import { removeOptimistically } from "@/lib/client/optimistic";
import { swap } from "@/lib/motion";
import type { Agent, ModelOption, Role, RoomSummary, ToolKind } from "@/lib/types";
import { Confirm } from "@/components/overlays/Confirm";
import { Modal } from "@/components/overlays/Modal";
import { useToast } from "@/components/overlays/Toast";
import { Button } from "@/components/ui/Button";
import { MenuItem, RowMenu } from "@/components/ui/RowMenu";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { PanelSection } from "@/components/ui/PanelSection";
import { AgentForm, TOOL_KINDS, type AgentInput } from "./AgentForm";
import { AgentAvatar } from "@/components/ui/AgentAvatar";
import { useRoomData } from "./useRoomData";

type Agents = { agents: Agent[]; kinds: ToolKind[] };
type Me = { userId: string; role: Role };

/**
 * The room's agents: anyone uses any of them and adds their own; an agent's creator or an admin changes it. The
 * server's list is the truth, fetched again when the agents change and when the room does (its connections decide
 * which tool kinds are on offer). A save shows the server's answer at once; a delete shows on the tap and is undone
 * if the server refuses.
 */
export function AgentsPanel({ roomId, me, rooms, models, archived }: {
  roomId: string; me: Me; rooms: RoomSummary[]; models: ModelOption[]; archived: boolean;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/bff/api/rooms/${roomId}/agents`;
  const targets = copyTargets(rooms, roomId);
  const { data, setData, failed, reload } = useRoomData<Agents>(base);
  const setAgents = (change: (list: Agent[]) => Agent[]) => setData((d) => d && { ...d, agents: change(d.agents) });
  const refetch = (e: { roomId: string }) => e.roomId === roomId && reload();
  useLiveEvent("agents.changed", refetch);
  useLiveEvent("room.updated", refetch);

  async function save(agent: Agent | undefined, input: AgentInput) {
    setBusy(true);
    try {
      // The built-in @agent can't be renamed, so its name isn't sent at all.
      const { instructions, tools, model } = input;
      const { agent: saved } = agent
        ? await bff<{ agent: Agent }>(`${base}/${agent.agentId}`, { method: "PATCH", body: agent.builtIn ? { instructions, tools, model } : input })
        : await bff<{ agent: Agent }>(base, { body: input });
      setAgents((list) => (agent ? list.map((a) => (a.agentId === saved.agentId ? saved : a)) : [...list, saved]));
      setEditing(null);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  function remove(agent: Agent) {
    setDeleting(null);
    removeOptimistically({ list: data!.agents, item: agent, key: (a) => a.agentId, set: setAgents }, () =>
      bff(`${base}/${agent.agentId}`, { method: "DELETE", body: {} }))
      .then(() => toast(`@${agent.name} deleted`), (e) => toast(errorText(e), "error"));
  }

  async function copy(agent: Agent, room: RoomSummary) {
    setMenuFor(null);
    try {
      toast(copyToast(room.name, await bff<CopyResult>(`${base}/${agent.agentId}/copy`, { body: { toRoomId: room.roomId } })));
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const newButton = data && !archived && editing !== "new" && (
    <Button onClick={() => setEditing("new")} size="sm" aria-label="New agent"><Plus aria-hidden="true" size={14} />New</Button>
  );

  return (
    <PanelSection title="Agents" action={newButton}>
      {!data && <PanelLoading failed={failed} onRetry={reload} />}
      {data && (
        <ul className="-mx-2 flex flex-col gap-1">
          {data.agents.map((a) => {
            const canEdit = !archived && canEditAgent(a, me);
            const canCopy = !a.builtIn && targets.length > 0;
            return (
              <li key={a.agentId}>
                <AnimatePresence mode="wait" initial={false}>
                  {editing === a.agentId
                    ? (
                      <motion.div key="form" {...swap}>
                        <AgentForm initial={a} kinds={data.kinds} models={models} busy={busy} onCancel={() => setEditing(null)} onSubmit={(input) => save(a, input)} />
                      </motion.div>
                    )
                    : (
                      <motion.div key="row" {...swap} className="flex min-h-12 items-center gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-surface-2">
                        <AgentAvatar size={28} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-[13px] font-medium">@{a.name}</span>
                            <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-px text-[11px] text-text-2">{modelChip(a, models)}</span>
                          </span>
                          <span className="flex items-center gap-1.5 text-[11.5px] text-text-3">
                            <span className="flex gap-1" aria-label={`Tools: ${toolNames(a.tools)}`} role="img">
                              {TOOL_KINDS.filter((k) => a.tools.includes(k.kind)).map(({ kind, icon: Icon }) => <Icon key={kind} aria-hidden="true" size={12} />)}
                            </span>
                            <span className="truncate">{a.builtIn ? "built in" : `by ${a.createdByName}`}</span>
                          </span>
                        </span>
                        {(canEdit || canCopy) && (
                          <RowMenu open={menuFor === a.agentId} onToggle={(o) => setMenuFor(o ? a.agentId : null)} name={`@${a.name}`}>
                            {canEdit && <MenuItem onClick={() => { setMenuFor(null); setEditing(a.agentId); }}>Edit</MenuItem>}
                            {canCopy && targets.map((r) => <MenuItem key={r.roomId} onClick={() => copy(a, r)}>Copy to {r.name}</MenuItem>)}
                            {canEdit && !a.builtIn && <MenuItem danger onClick={() => { setMenuFor(null); setDeleting(a); }}>Delete</MenuItem>}
                          </RowMenu>
                        )}
                      </motion.div>
                    )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      )}
      {data && editing === "new" && (
        <AgentForm kinds={data.kinds} models={models} busy={busy} onCancel={() => setEditing(null)} onSubmit={(input) => save(undefined, input)} />
      )}

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={`Delete @${deleting?.name}?`}>
        {deleting && (
          <Confirm action="Delete agent" onCancel={() => setDeleting(null)} onConfirm={async () => remove(deleting)}>
            Its schedules are deleted too. Its threads stay, and @agent answers them from now on.
          </Confirm>
        )}
      </Modal>
    </PanelSection>
  );
}

function modelChip(agent: Agent, models: ModelOption[]) {
  if (agent.model === "room") return "room default";
  return models.find((m) => m.pick === agent.model)?.short ?? agent.model;
}

const toolNames = (tools: ToolKind[]) => TOOL_KINDS.filter((k) => tools.includes(k.kind)).map((k) => k.label).join(", ") || "none";
