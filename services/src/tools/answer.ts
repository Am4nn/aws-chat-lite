import { UserError } from "../lib/errors.js";
import type { ToolResult } from "./types.js";

/**
 * A refusal a repo writes for people (a bad input, an unknown id, a full memory) goes back to the model as-is. Anything
 * else throws, so the step fails and is tried again.
 */
export async function answer(work: () => Promise<string>): Promise<ToolResult> {
  try {
    return { ok: true, output: await work() };
  } catch (e) {
    if (e instanceof UserError) return { ok: false, output: e.message };
    throw e;
  }
}
