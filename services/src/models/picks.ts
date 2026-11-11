import { ValidationError } from "../lib/errors.js";
import { MODELS, modelOptions, type ModelPick } from "./catalog.js";
import { type TaintSource } from "./privacy.js";

export const ROUTER_PROMPT =
  "Pick the model for this team-chat request. Reply with one word. haiku: greetings, small talk, quick facts, short rewrites or summaries. sonnet: code, debugging, tools, analysis, planning, or anything with several steps. If unsure, reply sonnet.";

export function parsePick(raw: unknown, stage: string): ModelPick | undefined {
  if (raw === undefined || raw === null) return undefined;
  const known = modelOptions(stage).find((o) => o.pick === raw);
  if (!known) throw new ValidationError("Unknown model.");
  return known.pick;
}

/** A room default that cannot see private content falls back to Auto instead of failing the send. */
export function resolvePick(
  pick: ModelPick | undefined,
  roomDefault: ModelPick,
  taint: TaintSource[],
): { pick: ModelPick; by: "pick" | "default" } {
  if (pick) return { pick, by: "pick" };
  const blocked = taint.length > 0 && !Object.values(MODELS).find((m) => m.pick === roomDefault)?.privateOk;
  return { pick: blocked && roomDefault !== "auto" ? "auto" : roomDefault, by: "default" };
}

export function modelIdOf(pick: Exclude<ModelPick, "auto">): string {
  const model = Object.values(MODELS).find((m) => m.pick === pick);
  if (!model) throw new Error(`Unknown pick ${pick}`);
  return model.id;
}

export const routerInput = (text: string) => text.slice(0, 4000);

/** Auto only ever chooses between these two; any other reply means Sonnet. */
export function parseRoute(reply: string): "claude-haiku-5-5" | "claude-sonnet-5-5" {
  return reply.toLowerCase().replace(/[^a-z]/g, "") === "haiku" ? "claude-haiku-5-5" : "claude-sonnet-5-5";
}
