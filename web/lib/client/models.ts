import type { ModelOption, ModelPick, TaintSource } from "../types";
import { formatElapsed, formatUsd } from "./format";

type MenuState = { value: ModelPick; roomDefault: ModelPick; taint: TaintSource[]; isAdmin: boolean };
type MenuItem = { pick: ModelPick; label: string; price: string; selected: boolean; isDefault: boolean; disabled: boolean };

export function pickMenu(models: ModelOption[], s: MenuState) {
  const items: MenuItem[] = models.map((m) => ({
    pick: m.pick,
    label: m.label,
    price: m.price,
    selected: m.pick === s.value,
    isDefault: m.pick === s.roomDefault,
    disabled: !m.privateOk && s.taint.length > 0,
  }));
  return { items, privateNote: items.some((i) => i.disabled), canSetDefault: s.isAdmin && s.value !== s.roomDefault };
}

export function nextEnabled(items: { disabled: boolean }[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!items[i].disabled) return i;
  }
  return from;
}

export function pillLabel(models: ModelOption[], pick: ModelPick, phone: boolean): string {
  const m = models.find((o) => o.pick === pick);
  return m ? (phone ? m.short : m.label) : pick;
}

export const modelLabel = (models: ModelOption[], id: string): string => models.find((o) => o.id === id)?.label ?? id;

export function footerText(agent: { model: string; pick: ModelPick; costMicros: number; ms: number }, models: ModelOption[]): string {
  const label = modelLabel(models, agent.model);
  const routed = agent.pick === "auto" ? `Auto → ${label}` : label;
  return `${routed} · ${formatUsd(agent.costMicros)} · ${formatElapsed(agent.ms)}`;
}
