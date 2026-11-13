import { afterEach, describe, expect, it, vi } from "vitest";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { Conflict } from "../lib/errors.js";
import { agentsRepo } from "./repo.js";

vi.mock("../live/broadcast.js", () => ({ roomChanged: async () => {} }));

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const ann = { userId: "u1", username: "Ann" };
const scout = { name: "scout", instructions: "Find things.", tools: ["web" as const], model: "room" as const };
const stored = {
  pk: "ROOM#r", sk: "AGENT#a1", agentId: "a1", ...scout, builtIn: false, createdBy: "u1", createdByName: "Ann",
  createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
};

/**
 * Room `r`, where Ann is an admin and `scout` (a1) is hers, and the table's username records for `usernames`, which
 * sign-up stores lowercased. With `uncounted`, a transaction ending in an uncount is cancelled at that item, as the
 * count's guard against going below 0 does.
 */
function fakeTable(opts: { usernames?: string[]; uncounted?: boolean } = {}) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const { pk, sk } = c.input.Key as { pk: string; sk: string };
      if (sk.startsWith("MEMBER#")) return { Item: { role: "admin" } };
      if (sk === "AGENT#a1") return { Item: stored };
      if (opts.usernames?.some((u) => pk === `USERNAME#${u.toLowerCase()}`)) return { Item: { pk, sk } };
      return {};
    }
    if (c instanceof TransactWriteCommand && opts.uncounted) {
      const items = c.input.TransactItems!;
      if (items.at(-1)?.Update?.ExpressionAttributeValues?.[":by"] === -1) {
        throw Object.assign(new Error("cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: items.map((_, i) => ({ Code: i === items.length - 1 ? "ConditionalCheckFailed" : "None" })),
        });
      }
    }
    return {};
  }) as never);
}

const transactions = (send: ReturnType<typeof fakeTable>) =>
  send.mock.calls.map(([c]) => c).filter((c) => c instanceof TransactWriteCommand).map((t) => (t as TransactWriteCommand).input.TransactItems!);

/** What each transaction does to the global name counts, as `name: change`. */
const countChanges = (items: NonNullable<TransactWriteCommand["input"]["TransactItems"]>) => items
  .filter((i) => String(i.Update?.Key?.pk).startsWith("AGENTNAME#"))
  .map((i) => `${String(i.Update!.Key!.pk).slice("AGENTNAME#".length)}: ${i.Update!.ExpressionAttributeValues![":by"]}`);

const refusal = (name: string) => new Conflict(`@${name} is someone's username.`);

describe("agents repo: names are never someone's username", () => {
  it("refuses any person's name in any case, on create, rename and an agent's own create, without asking Cognito", async () => {
    const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send");
    const send = fakeTable({ usernames: ["Goat"] });
    const agents = agentsRepo();
    await expect(agents.create(ann, "r", { ...scout, name: "goat" })).rejects.toEqual(refusal("goat"));
    await expect(agents.update(ann, "r", "a1", { name: "goat" })).rejects.toEqual(refusal("goat"));
    await expect(agents.createByAgent("r", { ...scout, name: "goat" }, { agentId: "a1", name: "scout" })).rejects.toEqual(refusal("goat"));
    expect(transactions(send)).toEqual([]);
    expect(cognito).not.toHaveBeenCalled();
  });

  it("a copy moves past names that are usernames", async () => {
    fakeTable({ usernames: ["scout", "Scout-2"] });
    expect(await agentsRepo().create(ann, "r", scout, { unique: true })).toMatchObject({ name: "scout-3" });
  });
});

describe("agents repo: the global count of each name", () => {
  it("a create counts its name in the same transaction", async () => {
    const send = fakeTable();
    await agentsRepo().create(ann, "r", { ...scout, name: "reviewer" });
    const [items] = transactions(send);
    expect(countChanges(items!)).toEqual(["reviewer: 1"]);
    expect(items!.at(-1)!.Update).toMatchObject({ Key: { pk: "AGENTNAME#reviewer", sk: "META" }, UpdateExpression: "ADD agentCount :by" });
  });

  it("a rename counts the new name and uncounts the old one, never below 0", async () => {
    const send = fakeTable();
    await agentsRepo().update(ann, "r", "a1", { name: "finder" });
    const [items] = transactions(send);
    expect(countChanges(items!)).toEqual(["finder: 1", "scout: -1"]);
    expect(items!.at(-1)!.Update).toMatchObject({ ConditionExpression: "agentCount > :zero" });
  });

  it("an edit that keeps the name leaves the counts alone", async () => {
    const send = fakeTable();
    await agentsRepo().update(ann, "r", "a1", { instructions: "x" });
    expect(transactions(send)).toEqual([]);
  });

  it("a delete uncounts its name", async () => {
    const send = fakeTable();
    await agentsRepo().remove(ann, "r", "a1");
    expect(transactions(send).map(countChanges)).toEqual([["scout: -1"]]);
  });

  it("the name of an agent made before counting began stays at 0: the write goes through without its uncount", async () => {
    const send = fakeTable({ uncounted: true });
    await agentsRepo().remove(ann, "r", "a1");
    expect(transactions(send).map(countChanges)).toEqual([["scout: -1"], []]);
  });
});
