import { describe, expect, it } from "vitest";
import { NotFound, ValidationError } from "../lib/errors.js";
import type { MemoryEntry } from "../threads/types.js";
import type { ToolEnv } from "../tools/types.js";
import type { MemoryStore } from "./tools.js";
import { memoryTools } from "./tools.js";

type Saved = Parameters<MemoryStore["save"]>[1];
type Change = Parameters<MemoryStore["update"]>[2];

/** Records what the tools ask of the repo; ids other than `known` are missing. */
function fakeStore(opts: { full?: boolean } = {}) {
  const calls: { saved: Saved[]; updated: [string, Change][]; forgot: string[] } = { saved: [], updated: [], forgot: [] };
  const known = "ab12cd34";
  const store: MemoryStore = {
    async save(_roomId, input) {
      if (opts.full) throw new ValidationError("Room memory is full (50 entries). Forget or update one first.");
      calls.saved.push(input);
      return { memoryId: known } as MemoryEntry;
    },
    async update(_roomId, id, change) {
      if (id !== known) throw new NotFound(`No memory [${id}].`);
      calls.updated.push([id, change]);
      return { memoryId: id } as MemoryEntry;
    },
    async forget(_roomId, id) {
      if (id !== known) throw new NotFound(`No memory [${id}].`);
      calls.forgot.push(id);
    },
  };
  return { store, calls };
}

const env = (tainted: boolean): ToolEnv => ({
  fetch, fetchPage: () => Promise.reject(new Error("unused")), keys: {}, mcpCall: () => Promise.reject(new Error("unused")),
  room: {
    roomId: "r1", threadId: "t12", threadNumber: 12, runId: "run1", agentId: "a-scout", agentName: "scout", tainted, postCap: 10,
  },
});

function tools(opts: { full?: boolean } = {}) {
  const { store, calls } = fakeStore(opts);
  const byName = Object.fromEntries(memoryTools(() => store).map((t) => [t.spec.name, t]));
  return { save: byName.memory_save!, update: byName.memory_update!, forget: byName.memory_forget!, calls };
}

describe("memory tools", () => {
  it("are memory-kind tools that aren't writes, and only forgetting asks first", () => {
    for (const t of memoryTools(() => fakeStore().store)) expect(t).toMatchObject({ kind: "memory", write: false });
    expect(memoryTools(() => fakeStore().store).filter((t) => t.ask).map((t) => t.spec.name)).toEqual(["memory_forget"]);
  });

  it("memory_save from a tainted thread saves a private entry, credited to the agent and thread", async () => {
    const { save, calls } = tools();
    expect(await save.run({ text: "Acme renews in March." }, env(true))).toEqual({ ok: true, output: "Saved to room memory as [ab12cd34]; from your next turn it is listed in the room memory." });
    expect(calls.saved).toEqual([{ text: "Acme renews in March.", private: true, source: { kind: "agent", agent: "scout", threadNumber: 12 } }]);
  });

  it("memory_save from a clean thread saves a public one", async () => {
    const { save, calls } = tools();
    await save.run({ text: "Deploys go out on Fridays." }, env(false));
    expect(calls.saved[0]?.private).toBe(false);
  });

  it("memory_save tells the model when memory is full", async () => {
    expect(await tools({ full: true }).save.run({ text: "x" }, env(false)))
      .toEqual({ ok: false, output: "Room memory is full (50 entries). Forget or update one first." });
  });

  it("memory_update rewrites an entry as the agent, and an update from a tainted thread makes it private", async () => {
    const { update, calls } = tools();
    expect(await update.run({ id: "ab12cd34", text: "Deploys go out on Thursdays." }, env(true))).toEqual({ ok: true, output: "Updated [ab12cd34]." });
    expect(calls.updated).toEqual([["ab12cd34", { text: "Deploys go out on Thursdays.", by: "scout", private: true }]]);
  });

  it("memory_forget deletes an entry", async () => {
    const { forget, calls } = tools();
    expect(await forget.run({ id: "ab12cd34" }, env(false))).toEqual({ ok: true, output: "Forgot [ab12cd34]." });
    expect(calls.forgot).toEqual(["ab12cd34"]);
  });

  it("memory_forget deletes, so it asks a member first, naming the entry", () => {
    const { forget } = tools();
    expect(forget.destructive).toBe(true);
    expect(forget.ask!({ id: "ab12cd34" }, env(false))).toBe("Forget [ab12cd34] from the room memory?");
  });

  it("an unknown id is a failed call the model can read", async () => {
    const { update, forget } = tools();
    expect(await update.run({ id: "x", text: "y" }, env(false))).toEqual({ ok: false, output: "No memory [x]." });
    expect(await forget.run({ id: "x" }, env(false))).toEqual({ ok: false, output: "No memory [x]." });
  });

  it("shows the text or id on the step row", () => {
    const { save, forget } = tools();
    expect(save.detail({ text: "Deploys go out on Fridays." })).toBe("Deploys go out on Fridays.");
    expect(forget.detail({ id: "ab12cd34" })).toBe("[ab12cd34]");
  });
});
