import type { ApprovalStatus, RunEvent } from "../types";
import { applyToLane, type Lane } from "./run";

export type MapNode = {
  id: string;
  lane: number;
  step?: number;
  kind: "steer" | "tool" | "answer";
  name: string;
  /** What the step did, in a line. */
  detail?: string;
  status: "running" | "done" | "failed" | "waiting";
  x: number;
  y: number;
  /** Since the run started. */
  startedMs: number;
  ms?: number;
  tokens?: number;
  costMicros?: number;
  /** The room files a sandbox step saved: the first one's name, and how many more. */
  file?: string;
  output?: string;
  approval?: { title: string; status: ApprovalStatus; by?: string };
};

export type MapEdge = { from: string; to: string; d: string; helper: boolean; waiting: boolean; waitsForHelper: boolean };
type Point = { x: number; y: number };

/** `at`: where a helper's name shows, under its lane's first card. The run's own lane goes unnamed. */
export type MapLane = { lane: number; agent: string; helper: boolean; at?: Point };
export type RunMap = { lanes: MapLane[]; nodes: MapNode[]; edges: MapEdge[]; width: number; height: number };

const CARD = { w: 108, h: 72 };
const PITCH = 124;
const FIRST_X = 24;
const ROW = 80;
const LANE_GAP = 44;
const CARD_TOP = 12;
const PAD = 12;
/** A helper's name sits this far under its first card, in a line this tall. */
const LABEL = { gap: 6, h: 18 };
/**
 * The map is drawn to the right of the prompt block (96 px tall), so its x = 0 is the block's right edge and the first
 * cards sit level with the block's middle.
 */
const PROMPT_MID = 48;

/** A smooth curve between two cards: along a lane it bends through the horizontal midpoint, across lanes the vertical. */
export function edgePath(a: Point, b: Point, across = false): string {
  if (across) {
    const my = (a.y + b.y) / 2;
    return `M${a.x} ${a.y} C${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
  }
  const mx = (a.x + b.x) / 2;
  return `M${a.x} ${a.y} C${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

/** The arc over a lane, from a delegate step to the lane's next step, that says the lane waited for its helper. */
function arcPath(a: MapNode, b: MapNode): string {
  const [ax, ay, bx, by] = [a.x + CARD.w, a.y + 28, b.x, b.y + 28];
  const top = Math.min(ay, by) - 36;
  return `M${ax} ${ay} C${ax + 42} ${top}, ${bx - 42} ${top}, ${bx} ${by}`;
}

/**
 * A column of cards in one lane: a model turn's calls (which carry its usage), steers read together, or one card on
 * its own (the ask, an answer).
 */
type Group = { kind: "turn" | "steers" | "solo"; col?: number; nodes: MapNode[]; tokens: number; costMicros: number };
type LaneState = { lane: number; agent: string; groups: Group[]; lastAt: number; view: Lane; delegate?: MapNode };

/**
 * Lays a run's events out as a map beside its prompt: a lane per agent with time flowing left to right, a card per
 * step, and the edges between them, starting from the prompt. Calls one model turn made share a column, stacked, and a helper's turns take the columns after its
 * delegate step, so the lane that waited for it resumes to their right. A model turn's tokens and cost are split
 * evenly over the calls it made; the turn that made none is the lane's answer.
 */
export function runMap(events: RunEvent[], nowMs: number): RunMap {
  if (!events.length) return { lanes: [], nodes: [], edges: [], width: 0, height: 0 };
  const started = events.find((e) => e.type === "run.started");
  const agentName = started?.type === "run.started" ? started.agentName : "agent";
  const t0 = Date.parse(events[0].at);
  const ended = events.find((e) => e.type === "run.finished");
  const endMs = ended ? Date.parse(ended.at) : nowMs;
  const lanes = new Map<number, LaneState>();
  const steps = new Map<number, MapNode>();
  const own = new Map<MapNode, number>();
  let columns = 0;

  const openLane = (lane: number, agent: string, at: number) => {
    const state: LaneState = { lane, agent, groups: [], lastAt: at, view: { items: [], text: "" } };
    lanes.set(lane, state);
    return state;
  };
  openLane(0, agentName, t0);

  // A card joins the lane's last column when that column is of its kind (an empty one, for a card on its own).
  const groupFor = (lane: LaneState, kind: Group["kind"]) => {
    const last = lane.groups.at(-1);
    if (last?.kind === kind && (kind !== "solo" || !last.nodes.length)) return last;
    const group: Group = { kind, nodes: [], tokens: 0, costMicros: 0 };
    lane.groups.push(group);
    return group;
  };
  const place = (lane: LaneState, kind: Group["kind"], node: Omit<MapNode, "lane" | "x" | "y">) => {
    const group = groupFor(lane, kind);
    group.col ??= columns++;
    const placed = { ...node, lane: lane.lane, x: 0, y: 0 };
    group.nodes.push(placed);
    return placed;
  };
  const stepNode = (lane: LaneState, step: number, at: string, name: string) => {
    let node = steps.get(step);
    if (!node) steps.set(step, (node = place(lane, "turn", { id: `step-${step}`, step, kind: "tool", name, status: "running", startedMs: Date.parse(at) - t0 })));
    return node;
  };
  // The lane's last turn made no calls, so that turn's usage and the lane's text are its answer.
  const answer = (lane: LaneState, at: string, ok: boolean) => {
    if (!lane.view.text) return;
    const last = lane.groups.at(-1);
    if (last?.kind === "turn" && !last.nodes.length) last.kind = "solo";
    place(lane, "solo", {
      id: `answer-${lane.lane}`, kind: "answer", name: "answer", status: ok ? "done" : "failed",
      detail: lane.lane ? `Handed back to @${agentName}` : "Answered the thread",
      startedMs: lane.lastAt - t0, ms: Date.parse(at) - lane.lastAt, output: lane.view.text,
    });
  };

  for (const e of events) {
    if (e.type === "helper.started") {
      const delegate = steps.get(e.step);
      if (delegate) delegate.name = `@${e.agentName}`;
      openLane(e.lane ?? 0, e.agentName, Date.parse(e.at)).delegate = delegate;
      continue;
    }
    const lane = lanes.get(e.lane ?? 0);
    if (!lane) continue;
    switch (e.type) {
      case "steer":
        place(lane, "steers", { id: `steer-${e.messageSeq}`, kind: "steer", name: `${e.authorName} steers`, status: "done", startedMs: Date.parse(e.at) - t0, output: e.text });
        break;
      case "text":
      case "text.reset":
        lane.view = applyToLane(lane.view, e);
        break;
      case "usage": {
        // Sandbox time and Gemini images are billed while (or right after) their step runs, so they are its own cost.
        if (e.job === "sandbox" || e.job === "image") {
          const node = lane.groups.flatMap((g) => g.nodes).at(-1);
          if (node) own.set(node, (own.get(node) ?? 0) + e.costMicros);
        }
        if (e.job !== "run") break;
        // A turn tried again bills each attempt, and the calls it ends with carry all of them.
        let group = lane.groups.at(-1);
        if (group?.kind !== "turn" || group.nodes.length) lane.groups.push((group = { kind: "turn", nodes: [], tokens: 0, costMicros: 0 }));
        group.tokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
        group.costMicros += e.costMicros;
        break;
      }
      case "approval.requested":
        Object.assign(stepNode(lane, e.step, e.at, e.call.name), { status: "waiting", approval: { title: e.title, status: "pending" } });
        break;
      case "approval.settled": {
        const node = steps.get(e.step);
        if (node) Object.assign(node, { status: e.decision === "approved" ? "running" : "failed", approval: { ...node.approval!, status: e.decision, by: e.by } });
        break;
      }
      case "step.started":
        Object.assign(stepNode(lane, e.step, e.at, e.call.name), { status: "running", detail: e.detail, startedMs: Date.parse(e.at) - t0 });
        break;
      case "step.finished": {
        const node = steps.get(e.step);
        if (node) Object.assign(node, { status: e.ok ? "done" : "failed", ms: e.ms, output: e.output });
        lane.lastAt = Date.parse(e.at);
        break;
      }
      case "files.synced": {
        const node = steps.get(e.step);
        if (node && e.written.length) node.file = e.written[0] + (e.written.length > 1 ? ` +${e.written.length - 1}` : "");
        break;
      }
      case "helper.finished":
      case "run.finished":
        answer(lane, e.at, e.status === "done");
        break;
    }
  }

  for (const g of [...lanes.values()].flatMap((l) => l.groups)) {
    g.nodes.forEach((n, i) => {
      n.tokens = share(g.tokens, g.nodes.length, i);
      n.costMicros = share(g.costMicros, g.nodes.length, i) + (own.get(n) ?? 0);
      if (n.status === "running" || n.status === "waiting") n.ms = endMs - t0 - n.startedMs;
    });
  }

  const laneList: MapLane[] = [];
  let top = CARD_TOP;
  let bottom = 0;
  for (const lane of lanes.values()) {
    const rows = Math.max(1, ...lane.groups.map((g) => g.nodes.length));
    for (const g of lane.groups) {
      g.nodes.forEach((n, row) => {
        n.x = FIRST_X + g.col! * PITCH;
        n.y = top + row * ROW + ((rows - g.nodes.length) * ROW) / 2;
      });
    }
    const helper = lane.lane > 0;
    const first = lane.groups.find((g) => g.nodes.length)?.nodes[0];
    const at = helper && first ? { x: first.x, y: first.y + CARD.h + LABEL.gap } : undefined;
    laneList.push({ lane: lane.lane, agent: lane.agent, helper, at });
    const height = CARD.h + (rows - 1) * ROW;
    bottom = top + height + (at ? LABEL.gap + LABEL.h : 0);
    top += height + LANE_GAP;
  }

  const columnsOf = (lane: LaneState) => lane.groups.filter((g) => g.nodes.length);
  const delegates = new Set([...lanes.values()].flatMap((l) => (l.delegate ? [l.delegate] : [])));
  const edges: MapEdge[] = [];
  const link = (a: MapNode, b: MapNode, kind: "flow" | "helper" | "waits") => {
    const d = kind === "waits" ? arcPath(a, b)
      : kind === "flow" ? edgePath({ x: a.x + CARD.w, y: a.y + CARD.h / 2 }, { x: b.x, y: b.y + CARD.h / 2 })
      : b.y > a.y ? edgePath({ x: a.x + CARD.w / 2, y: a.y + CARD.h }, { x: b.x + CARD.w / 2, y: b.y }, true)
      : edgePath({ x: a.x + CARD.w / 2, y: a.y }, { x: b.x + CARD.w / 2, y: b.y + CARD.h }, true);
    edges.push({ from: a.id, to: b.id, d, helper: kind === "helper", waiting: b.status === "waiting", waitsForHelper: kind === "waits" });
  };
  for (const n of columnsOf(lanes.get(0)!)[0]?.nodes ?? []) {
    const d = edgePath({ x: 0, y: PROMPT_MID }, { x: n.x, y: n.y + CARD.h / 2 });
    edges.push({ from: "prompt", to: n.id, d, helper: false, waiting: n.status === "waiting", waitsForHelper: false });
  }
  for (const lane of lanes.values()) {
    const cols = columnsOf(lane);
    cols.slice(1).forEach((b, i) => {
      for (const a of cols[i].nodes) {
        if (delegates.has(a)) link(a, b.nodes[0], "waits");
        else for (const n of b.nodes) link(a, n, "flow");
      }
    });
  }
  for (const helper of lanes.values()) {
    const from = helper.delegate;
    const cols = columnsOf(helper);
    if (!from || !cols.length) continue;
    for (const n of cols[0].nodes) link(from, n, "helper");
    const main = columnsOf(lanes.get(from.lane)!);
    const back = main[main.findIndex((g) => g.nodes.includes(from)) + 1];
    if (back) for (const n of cols.at(-1)!.nodes) link(n, back.nodes[0], "helper");
  }

  return {
    lanes: laneList, nodes: [...lanes.values()].flatMap((l) => l.groups.flatMap((g) => g.nodes)).sort((a, b) => a.x - b.x || a.y - b.y), edges,
    width: columns ? FIRST_X + (columns - 1) * PITCH + CARD.w + PAD : 0, height: bottom,
  };
}

/** One of `n` even parts of `total`, the first taking the remainder. */
const share = (total: number, n: number, i: number) => Math.floor(total / n) + (i === 0 ? total % n : 0);

const SHARES = [
  { key: "thinking", label: "thinking", color: "var(--color-line-hover)" },
  { key: "helpers", label: "helpers", color: "var(--color-sky)" },
  { key: "tools", label: "tools", color: "var(--color-lime)" },
  { key: "waiting", label: "waiting", color: "var(--color-amber)" },
] as const;

type Share = (typeof SHARES)[number] & { pct: number };

/**
 * Where the time (or money) of a thread's runs went, in whole percents that add up to 100: the main agent's model
 * calls, its helpers, its other tool calls, and waiting on members' approvals. A helper's own split is inside its share.
 */
export function timeShares(runs: RunEvent[][], by: "time" | "cost"): Share[] {
  const sums = { thinking: 0, helpers: 0, tools: 0, waiting: 0 };
  for (const events of runs) addShares(sums, events, by === "time");
  const total = sums.thinking + sums.helpers + sums.tools + sums.waiting;
  if (!total) return [];
  const exact = SHARES.map((s) => ({ ...s, exact: (sums[s.key] * 100) / total })).filter((s) => s.exact > 0);
  // Largest remainder: round every share down, then give the points left to the shares that lost the most.
  const shares = exact.map(({ exact: x, ...s }) => ({ ...s, pct: Math.floor(x) }));
  const left = 100 - shares.reduce((sum, s) => sum + s.pct, 0);
  const order = exact.map((s, i) => i).sort((a, b) => (exact[b].exact % 1) - (exact[a].exact % 1));
  for (const i of order.slice(0, left)) shares[i].pct += 1;
  return shares;
}

/** Adds one run's split to `sums`. Step numbers restart in every run, so an approval is timed within its own run. */
function addShares(sums: Record<Share["key"], number>, events: RunEvent[], time: boolean) {
  const delegates = new Set(events.flatMap((e) => (e.type === "step.started" && !e.lane && e.call.name === "delegate" ? [e.step] : [])));
  const asked = new Map<number, number>();
  for (const e of events) {
    if (e.type === "helper.finished") sums.helpers += time ? e.ms : e.costMicros;
    if (e.lane) continue;
    if (e.type === "usage" && e.job === "run") sums.thinking += time ? e.ms ?? 0 : e.costMicros;
    if (e.type === "usage" && (e.job === "sandbox" || e.job === "image") && !time) sums.tools += e.costMicros;
    if (e.type === "step.finished" && time && !delegates.has(e.step)) sums.tools += e.ms;
    if (e.type === "approval.requested") asked.set(e.step, Date.parse(e.at));
    if (e.type === "approval.settled" && time && asked.has(e.step)) sums.waiting += Date.parse(e.at) - asked.get(e.step)!;
  }
}
