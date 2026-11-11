import { UserError } from "../lib/errors.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { type MemoryRepo, memoryRepo } from "./repo.js";

export type MemoryStore = Pick<MemoryRepo, "save" | "update" | "forget">;

/** A refusal the repo writes for people (memory full, a bad length, an unknown id) goes back to the model as-is. */
async function answer(work: () => Promise<string>): Promise<ToolResult> {
  try {
    return { ok: true, output: await work() };
  } catch (e) {
    if (e instanceof UserError) return { ok: false, output: e.message };
    throw e;
  }
}

const idSchema = { type: "string", description: "The entry's id, shown in brackets in the room memory." };

/**
 * The room memory tools, offered to every model. They read and write only the room's own notes, so they never wait
 * for approval and taint nothing. What a thread with private content saves or rewrites is marked private, which keeps
 * it from models that may not see private content. The repo is made when a tool runs, so the tools can be listed
 * beside the room's others where no table is configured.
 */
export function memoryTools(repo: () => MemoryStore = memoryRepo): Tool[] {
  return [
    {
      spec: {
        name: "memory_save",
        description: "Saves one short, lasting fact or decision to the room's memory, which every later run in this room "
          + "sees: decisions, conventions, preferences, who owns what. Don't save chit-chat, guesses or what is "
          + "already there: update or forget an entry instead. Up to 280 characters.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      kind: "memory",
      write: false,
      detail: (input) => String(input.text ?? ""),
      run: (input, env) => answer(async () => {
        const { agentName: agent, threadNumber, roomId, tainted } = env.room;
        const entry = await repo().save(roomId, { text: input.text, private: tainted, source: { kind: "agent", agent, threadNumber } });
        return `Saved to room memory as [${entry.memoryId}].`;
      }),
    },
    {
      spec: {
        name: "memory_update",
        description: "Rewrites an entry of the room's memory that is out of date. Up to 280 characters.",
        inputSchema: { type: "object", properties: { id: idSchema, text: { type: "string" } }, required: ["id", "text"] },
      },
      kind: "memory",
      write: false,
      detail: (input) => `[${input.id}] ${input.text ?? ""}`,
      run: (input, env) => answer(async () => {
        const id = String(input.id);
        await repo().update(env.room.roomId, id, { text: input.text, by: env.room.agentName, private: env.room.tainted });
        return `Updated [${id}].`;
      }),
    },
    {
      spec: {
        name: "memory_forget",
        description: "Deletes an entry of the room's memory that is wrong or no longer matters.",
        inputSchema: { type: "object", properties: { id: idSchema }, required: ["id"] },
      },
      kind: "memory",
      write: false,
      detail: (input) => `[${input.id}]`,
      run: (input, env) => answer(async () => {
        const id = String(input.id);
        await repo().forget(env.room.roomId, id);
        return `Forgot [${id}].`;
      }),
    },
  ];
}
