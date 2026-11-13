import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { Forbidden, ValidationError } from "../lib/errors.js";
import type { Role } from "../rooms/access.js";
import { copyAgent } from "./copy.js";

const accounts = vi.hoisted(() => new Set<string>());
vi.mock("../lib/users.js", () => ({ userExists: async (name: string) => accounts.has(name) }));

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => {
  vi.restoreAllMocks();
  accounts.clear();
});

const aman = { userId: "u1", username: "aman" };
const scout = {
  agentId: "a1", name: "scout", instructions: "Find things.", tools: ["github", "web"], model: "haiku", builtIn: false,
  createdBy: "u2", createdByName: "bee", createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
};
const digest = {
  scheduleId: "s1", agentId: "a1", title: "Morning digest", prompt: "Digest the new issues.", cadence: { kind: "daily", time: "09:00" },
  chatId: "c-from", enabled: true, createdBy: "u2", createdByName: "bee", createdAt: "2026-11-11T10:00:00.000Z",
};

/**
 * Two rooms: `from` holds `scout` and its schedule, `to` is where the caller has `targetRole`, has no GitHub, and
 * already has an agent named `scout` when `clash`.
 */
function fakeTable(targetRole: Role, opts: { clash?: boolean } = {}) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const { pk, sk } = c.input.Key as { pk: string; sk: string };
      if (sk.startsWith("MEMBER#")) return { Item: { role: pk === "ROOM#to" ? targetRole : "member" } };
      if (pk === "ROOM#from" && sk === "AGENT#a1") return { Item: { pk, sk, ...scout } };
      return {};
    }
    if (c instanceof QueryCommand) {
      const values = JSON.stringify(c.input.ExpressionAttributeValues);
      if (values.includes("SCHED#")) return { Items: [{ pk: "ROOM#from", sk: "SCHED#s1", ...digest }, { ...digest, scheduleId: "s2", agentId: "other" }] };
      if (values.includes('"CHAT#"')) return { Items: [{ chatId: "c-oldest" }] };
      return { Items: [] };
    }
    if (c instanceof TransactWriteCommand && opts.clash) {
      const guard = c.input.TransactItems?.[1]?.Put?.Item?.sk;
      if (guard === "AGENTNAME#scout") {
        throw Object.assign(new Error("cancelled"), {
          name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }, { Code: "None" }],
        });
      }
    }
    return {};
  }) as never);
}

const copiedSchedules = (send: ReturnType<typeof fakeTable>) => (send.mock.calls.map(([c]) => c)
  .filter((c) => c instanceof TransactWriteCommand) as TransactWriteCommand[])
  .map((t) => t.input.TransactItems!.at(-1)?.Put?.Item)
  .filter((item) => String(item?.sk).startsWith("SCHED#"));

describe("copyAgent", () => {
  it("refuses a target room where the caller is only a member", async () => {
    const send = fakeTable("member");
    await expect(copyAgent(aman, { roomId: "from", agentId: "a1" }, "to"))
      .rejects.toThrow(new Forbidden("You can copy agents only into rooms where you're an admin."));
    expect(send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(false);
  });

  it("refuses the built-in @agent", async () => {
    fakeTable("admin");
    await expect(copyAgent(aman, { roomId: "from", agentId: "agent" }, "to"))
      .rejects.toThrow(new ValidationError("The built-in @agent can't be renamed, deleted or copied."));
  });

  it("keeps the kinds the target offers and reports the rest", async () => {
    fakeTable("admin");
    const { agent, dropped } = await copyAgent(aman, { roomId: "from", agentId: "a1" }, "to");
    expect(agent).toMatchObject({ name: "scout", instructions: "Find things.", tools: ["web"], model: "haiku", createdBy: "u1" });
    expect(dropped).toEqual(["github"]);
  });

  it("takes the next free name when the target has one of its own", async () => {
    fakeTable("admin", { clash: true });
    expect((await copyAgent(aman, { roomId: "from", agentId: "a1" }, "to")).agent.name).toBe("scout-2");
  });

  it("takes the next name that is nobody's username either", async () => {
    fakeTable("admin");
    accounts.add("scout");
    expect((await copyAgent(aman, { roomId: "from", agentId: "a1" }, "to")).agent.name).toBe("scout-2");
  });

  it("copies the agent's own schedules, switched off, into the target's oldest chat, for the new agent and the copier", async () => {
    const send = fakeTable("admin");
    const { agent, schedules } = await copyAgent(aman, { roomId: "from", agentId: "a1" }, "to");
    expect(schedules).toEqual({ copied: 1, skipped: 0 });
    const [copy] = copiedSchedules(send);
    expect(copy).toMatchObject({
      pk: "ROOM#to", agentId: agent.agentId, title: "Morning digest", chatId: "c-oldest", enabled: false, createdBy: "u1", createdByName: "aman",
    });
    expect(copy?.scheduleId).not.toBe("s1");
  });
});
