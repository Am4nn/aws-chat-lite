import { createContext, useContext, useMemo } from "react";
import { isAdmin, type Agent, type Role, type RoomSummary, type ToolKind } from "../types";

/** The room's agents from its view, the built-in @agent first, for labels, the agent picker and the `@` list. */
export const RoomAgentsContext = createContext<Agent[]>([]);

/** The room's agent names, for highlighting their mentions. */
export function useAgentNames(): string[] {
  const agents = useContext(RoomAgentsContext);
  return useMemo(() => agents.map((a) => a.name), [agents]);
}

export type CopyResult = { agent: Agent; dropped: ToolKind[]; schedules: { copied: number; skipped: number } };

/** A thread whose agent was deleted is answered by @agent, so that's its label too. */
export const agentLabel = (agentId: string, agents: Agent[]) => `@${agents.find((a) => a.agentId === agentId)?.name ?? "agent"}`;

/** Mirrors the server's rule, which remains the real check: its creator or an admin, and only admins for @agent. */
export const canEditAgent = (agent: Agent, me: { userId: string; role: Role }) =>
  isAdmin(me.role) || (!agent.builtIn && agent.createdBy === me.userId);

/** A copy goes only into rooms I admin. */
export const copyTargets = (rooms: RoomSummary[], roomId: string) => rooms.filter((r) => r.roomId !== roomId && isAdmin(r.role));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function copyToast(roomName: string, { agent, dropped, schedules }: CopyResult): string {
  return [
    `Copied to ${roomName} as @${agent.name}`,
    dropped.length > 0 && `not connected there: ${dropped.join(", ")}`,
    schedules.copied > 0 && `${plural(schedules.copied, "schedule")} copied, off`,
    schedules.skipped > 0 && `${schedules.skipped} left out (that room has 5)`,
  ].filter(Boolean).join(" · ");
}
