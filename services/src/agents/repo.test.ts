import { afterEach, describe, expect, it, vi } from "vitest";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { Conflict } from "../lib/errors.js";
import { agentsRepo } from "./repo.js";

vi.mock("../live/broadcast.js", () => ({ roomChanged: async () => {} }));

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1", USER_POOL_ID: "pool-1" });

afterEach(() => vi.restoreAllMocks());

const ann = { userId: "u1", username: "Ann" };
const scout = { name: "scout", instructions: "Find things.", tools: ["web" as const], model: "room" as const };
const stored = {
  pk: "ROOM#r", sk: "AGENT#a1", agentId: "a1", ...scout, builtIn: false, createdBy: "u1", createdByName: "Ann",
  createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
};

/** Cognito, holding accounts by these exact names. */
const accounts = (...names: string[]) => vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation((async (c: { input: { Username: string } }) => {
  if (names.includes(c.input.Username)) return { Username: c.input.Username, Enabled: true };
  throw Object.assign(new Error("User does not exist."), { name: "UserNotFoundException" });
}) as never);

/**
 * Room `r`, where Ann is an admin and `scout` (a1) is hers. With `uncounted`, the transaction is cancelled at its last
 * item, as the global count's guard against going below 0 does.
 */
function fakeTable(opts: { uncounted?: boolean } = {}) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const sk = String(c.input.Key?.sk);
      if (sk.startsWith("MEMBER#")) return { Item: { role: "admin" } };
      if (sk === "AGENT#a1") return { Item: stored };
      return {};
    }
    if (c instanceof QueryCommand) return { Items: [{ username: "Ann" }] };
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
  it("refuses any account's name on create, rename and an agent's own create", async () => {
    accounts("bob");
    const send = fakeTable();
    const agents = agentsRepo();
    await expect(agents.create(ann, "r", { ...scout, name: "bob" })).rejects.toEqual(refusal("bob"));
    await expect(agents.update(ann, "r", "a1", { name: "bob" })).rejects.toEqual(refusal("bob"));
    await expect(agents.createByAgent("r", { ...scout, name: "bob" }, { agentId: "a1", name: "scout" })).rejects.toEqual(refusal("bob"));
    expect(transactions(send)).toEqual([]);
  });

  it("refuses a member's username here in any case, as mentions ignore case and Cognito's names don't", async () => {
    accounts("Ann");
    fakeTable();
    await expect(agentsRepo().create(ann, "r", { ...scout, name: "ann" })).rejects.toEqual(refusal("ann"));
  });

  it("a copy moves past names that are usernames", async () => {
    accounts("scout", "scout-2");
    fakeTable();
    expect(await agentsRepo().create(ann, "r", scout, { unique: true })).toMatchObject({ name: "scout-3" });
  });
});

describe("agents repo: the global count of each name", () => {
  it("a create counts its name in the same transaction", async () => {
    accounts();
    const send = fakeTable();
    await agentsRepo().create(ann, "r", { ...scout, name: "reviewer" });
    const [items] = transactions(send);
    expect(countChanges(items!)).toEqual(["reviewer: 1"]);
    expect(items!.at(-1)!.Update).toMatchObject({ Key: { pk: "AGENTNAME#reviewer", sk: "META" }, UpdateExpression: "ADD agentCount :by" });
  });

  it("a rename counts the new name and uncounts the old one, never below 0", async () => {
    accounts();
    const send = fakeTable();
    await agentsRepo().update(ann, "r", "a1", { name: "finder" });
    const [items] = transactions(send);
    expect(countChanges(items!)).toEqual(["finder: 1", "scout: -1"]);
    expect(items!.at(-1)!.Update).toMatchObject({ ConditionExpression: "agentCount > :zero" });
  });

  it("an edit that keeps the name leaves the counts alone", async () => {
    accounts();
    const send = fakeTable();
    await agentsRepo().update(ann, "r", "a1", { instructions: "x" });
    expect(transactions(send)).toEqual([]);
  });

  it("a delete uncounts its name", async () => {
    accounts();
    const send = fakeTable();
    await agentsRepo().remove(ann, "r", "a1");
    expect(transactions(send).map(countChanges)).toEqual([["scout: -1"]]);
  });

  it("the name of an agent made before counting began stays at 0: the write goes through without its uncount", async () => {
    accounts();
    const send = fakeTable({ uncounted: true });
    await agentsRepo().remove(ann, "r", "a1");
    expect(transactions(send).map(countChanges)).toEqual([["scout: -1"], []]);
  });
});
