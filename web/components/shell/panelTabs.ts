import { Activity, Bot, Folder, Search, Users, Workflow, type LucideIcon } from "lucide-react";

export type PanelTabId = "step" | "context" | "agents" | "room" | "people" | "search";

/**
 * The room panel's tabs, each an icon named on hover and to screen readers. Related panels share a tab as sections:
 * Agents holds agents, schedules and memory; Room holds files, connections, settings and activity; People holds
 * members and the invite link.
 */
export const PANEL_TABS: Record<PanelTabId, { label: string; icon: LucideIcon }> = {
  step: { label: "Step", icon: Workflow },
  context: { label: "Context", icon: Activity },
  agents: { label: "Agents", icon: Bot },
  room: { label: "Room", icon: Folder },
  people: { label: "People", icon: Users },
  search: { label: "Search", icon: Search },
};

/** Context belongs to a thread, and Step to a card picked on a thread's Map. */
export function panelTabIds({ thread, step }: { thread: boolean; step: boolean }): PanelTabId[] {
  return [...(step ? ["step" as const] : []), ...(thread ? ["context" as const] : []), "agents", "room", "people", "search"];
}
