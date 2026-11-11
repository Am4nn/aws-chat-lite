import { modelInfo, pickInfo, type ModelPick } from "./catalog.js";

/**
 * Why a thread is private. The set only grows; a new kind adds one word below. MCP output is recorded per server, as
 * `mcp:<name>`, because a read-only call may send a server its own earlier output without anyone approving: that
 * exposes nothing new, while anything else private would leave in the call's input.
 */
export type TaintSource = "attachment" | "github" | "sandbox" | `mcp:${string}`;

const words = "attachments, GitHub data, MCP tool output, sandbox files";

export const PICK_REFUSED = `This has private content (${words}), so DeepSeek is off here. Pick another model.`;
export const RUN_REFUSED = `This thread now has private content (${words}), so DeepSeek stopped. Send again with another model.`;

export const mcpTaint = (server: string): TaintSource => `mcp:${server}`;

export const messageTaint = (m: { attachments?: unknown[] }): TaintSource[] => (m.attachments?.length ? ["attachment"] : []);

export const mergeTaint = (...lists: TaintSource[][]): TaintSource[] => [...new Set(lists.flat())].sort();

export function pickRefusal(pick: ModelPick | undefined, taint: TaintSource[]): string | null {
  if (!pick || pick === "auto" || taint.length === 0) return null;
  const model = pickInfo(pick);
  return model && !model.privateOk ? PICK_REFUSED : null;
}

export function runRefusal(modelId: string, taint: TaintSource[]): { status: "failed"; reason: string } | null {
  return taint.length > 0 && !modelInfo(modelId).privateOk ? { status: "failed", reason: RUN_REFUSED } : null;
}
