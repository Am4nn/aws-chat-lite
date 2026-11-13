import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { handler as preSignUp } from "../auth/presignup.js";
import { docClient, tableName } from "../lib/db.js";
import { Conflict, Forbidden, NotFound, ValidationError } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { agentsRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const rooms = roomsRepo();
const agents = agentsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const agentCount = async (roomId: string) => (await docClient().send(new GetCommand({
  TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: "META" }, ConsistentRead: true,
}))).Item?.agentCount;
const nameCount = async (name: string) => (await docClient().send(new GetCommand({
  TableName: tableName(), Key: { pk: `AGENTNAME#${name}`, sk: "META" }, ConsistentRead: true,
}))).Item?.agentCount;
/** What a sign-up leaves in the table: the trigger's record of the name. */
const signUp = (userName: string) => preSignUp({ userName, response: {} } as PreSignUpTriggerEvent);
const scout = { name: "scout", instructions: "Find things.", tools: ["web" as const], model: "room" as const };

/** An owner, a member and an admin, in a new room. */
async function room() {
  const owner = user("Ann");
  const member = user("bob");
  const admin = user("cat");
  const { roomId } = await rooms.createRoom(owner, "Agents");
  const { code } = await rooms.rotateInvite(roomId, owner.userId);
  await rooms.acceptInvite(code, member);
  await rooms.acceptInvite(code, admin);
  await rooms.setRole(roomId, owner.userId, admin.userId, "admin");
  return { roomId, owner, member, admin };
}

describe("agents repo on Floci", () => {
  // The rooms' people, as signed up.
  beforeAll(() => Promise.all(["Ann", "bob", "cat"].map(signUp)));

  it("of two creates of one name at once, one wins", async () => {
    const { roomId, owner, member } = await room();
    const results = await Promise.allSettled([agents.create(owner, roomId, scout), agents.create(member, roomId, scout)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [lost] = results.filter((r) => r.status === "rejected");
    expect(lost.reason).toEqual(new Conflict("@scout is taken in this room."));
    expect((await agents.list(roomId)).map((a) => a.name)).toEqual(["agent", "scout"]);
  });

  it("gives a copy the next free name", async () => {
    const { roomId, owner } = await room();
    await agents.create(owner, roomId, scout);
    expect(await agents.create(owner, roomId, scout, { unique: true })).toMatchObject({ name: "scout-2" });
  });

  it("refuses anyone's username, in any case, from any room", async () => {
    const { roomId, member } = await room();
    const goat = `Goat-${randomUUID().slice(0, 8)}`;
    await signUp(goat);
    await expect(agents.create(member, roomId, { ...scout, name: goat.toLowerCase() }))
      .rejects.toEqual(new Conflict(`@${goat.toLowerCase()} is someone's username.`));
  });

  it("two rooms may share an agent name; its count follows creates, renames and deletes, and sign-up refuses it while above 0", async () => {
    const [a, b] = [await room(), await room()];
    const name = `rev-${randomUUID().slice(0, 8)}`;
    const first = await agents.create(a.owner, a.roomId, { ...scout, name });
    const second = await agents.create(b.owner, b.roomId, { ...scout, name });
    expect(await nameCount(name)).toBe(2);
    await agents.remove(a.owner, a.roomId, first.agentId);
    expect(await nameCount(name)).toBe(1);
    await expect(signUp(name.toUpperCase())).rejects.toThrow("That username is taken.");
    await agents.update(b.owner, b.roomId, second.agentId, { name: `${name}-x` });
    expect([await nameCount(name), await nameCount(`${name}-x`)]).toEqual([0, 1]);
    await expect(signUp(name.toUpperCase())).resolves.toMatchObject({ userName: name.toUpperCase() });
  });

  it("holds a room to 20 agents", async () => {
    const { roomId, owner } = await room();
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: "META" }, UpdateExpression: "SET agentCount = :n",
      ExpressionAttributeValues: { ":n": 20 },
    }));
    await expect(agents.create(owner, roomId, scout)).rejects.toEqual(new Conflict("A room has at most 20 agents."));
  });

  it("lets only the creator or an admin change an agent", async () => {
    const { roomId, owner, member, admin } = await room();
    const made = await agents.create(member, roomId, scout);
    expect(made).toMatchObject({ name: "scout", builtIn: false, createdBy: member.userId, createdByName: "bob" });
    await expect(agents.update(owner, roomId, made.agentId, { instructions: "x" })).resolves.toMatchObject({ instructions: "x" });
    const other = await agents.create(admin, roomId, { ...scout, name: "other" });
    await expect(agents.update(member, roomId, other.agentId, { instructions: "mine now" }))
      .rejects.toEqual(new Forbidden("Only its creator or an admin can change @other."));
    expect(await agents.update(admin, roomId, made.agentId, { model: "haiku" })).toMatchObject({ model: "haiku", instructions: "x" });
    expect(await agents.byId(roomId, made.agentId)).toMatchObject({ model: "haiku", instructions: "x" });
  });

  it("a rename moves the name, and frees the old one", async () => {
    const { roomId, member } = await room();
    const made = await agents.create(member, roomId, scout);
    await agents.create(member, roomId, { ...scout, name: "taken" });
    await expect(agents.update(member, roomId, made.agentId, { name: "taken" })).rejects.toEqual(new Conflict("@taken is taken in this room."));
    await expect(agents.update(member, roomId, made.agentId, { name: "bob" }))
      .rejects.toEqual(new Conflict("@bob is someone's username."));
    expect(await agents.update(member, roomId, made.agentId, { name: "finder" })).toMatchObject({ name: "finder" });
    await expect(agents.create(member, roomId, scout)).resolves.toMatchObject({ name: "scout" });
    await expect(agents.create(member, roomId, { ...scout, name: "finder" })).rejects.toEqual(new Conflict("@finder is taken in this room."));
  });

  it("only admins edit the built-in @agent, and nobody renames or deletes it", async () => {
    const { roomId, member, admin } = await room();
    await expect(agents.update(member, roomId, "agent", { instructions: "x" }))
      .rejects.toEqual(new Forbidden("Only its creator or an admin can change @agent."));
    const builtIn = await agents.update(admin, roomId, "agent", { instructions: "Be brief.", tools: ["web"] });
    expect(builtIn).toMatchObject({ agentId: "agent", name: "agent", builtIn: true, instructions: "Be brief.", tools: ["web"], model: "room" });
    expect((await agents.list(roomId))[0]).toEqual(builtIn);
    const refused = new ValidationError("The built-in @agent can't be renamed, deleted or copied.");
    await expect(agents.update(admin, roomId, "agent", { name: "boss" })).rejects.toEqual(refused);
    await expect(agents.remove(admin, roomId, "agent")).rejects.toEqual(refused);
  });

  it("a delete is soft and frees the name; the list keeps the built-in first", async () => {
    const { roomId, member } = await room();
    await agents.create(member, roomId, { ...scout, name: "zed" });
    const made = await agents.create(member, roomId, scout);
    expect((await agents.list(roomId)).map((a) => a.name)).toEqual(["agent", "scout", "zed"]);
    expect(await agentCount(roomId)).toBe(2);
    await agents.remove(member, roomId, made.agentId);
    expect(await agentCount(roomId)).toBe(1);
    expect((await agents.list(roomId)).map((a) => a.name)).toEqual(["agent", "zed"]);
    expect(await agents.byId(roomId, made.agentId)).toMatchObject({ name: "scout", deleted: true });
    await expect(agents.remove(member, roomId, made.agentId)).rejects.toEqual(new NotFound("No such agent."));
    await expect(agents.update(member, roomId, made.agentId, { instructions: "x" })).rejects.toEqual(new NotFound("No such agent."));
    await expect(agents.create(member, roomId, scout)).resolves.toMatchObject({ name: "scout" });
  });

  it("an agent-made agent records its maker; the approving member edits and deletes it as its creator; in Auto it has no approver and only admins and its maker change it", async () => {
    const { roomId, member, admin } = await room();
    const maker = await agents.create(admin, roomId, scout);
    const madeBy = { agentId: maker.agentId, name: "scout" };
    const approved = await agents.createByAgent(roomId, { ...scout, name: "helper", delegates: [] }, madeBy, member);
    expect(await agents.byId(roomId, approved.agentId)).toMatchObject({
      name: "helper", madeBy, createdBy: member.userId, createdByName: "bob", delegates: [], builtIn: false,
    });
    await expect(agents.update(member, roomId, approved.agentId, { instructions: "x" })).resolves.toMatchObject({ instructions: "x" });
    await agents.remove(member, roomId, approved.agentId);
    expect(await agents.byId(roomId, approved.agentId)).toMatchObject({ deleted: true });

    const auto = await agents.createByAgent(roomId, { ...scout, name: "runner" }, madeBy);
    expect(auto).toMatchObject({ createdBy: "", createdByName: "", madeBy });
    await expect(agents.update(member, roomId, auto.agentId, { instructions: "x" }))
      .rejects.toEqual(new Forbidden("Only its creator or an admin can change @runner."));
    await expect(agents.updateByAgent(roomId, auto.agentId, { instructions: "by its maker" }, maker.agentId))
      .resolves.toMatchObject({ instructions: "by its maker" });
    await expect(agents.update(admin, roomId, auto.agentId, { name: "fast" })).resolves.toMatchObject({ name: "fast" });
    await expect(agents.createByAgent(roomId, { ...scout, name: "bob" }, madeBy))
      .rejects.toEqual(new Conflict("@bob is someone's username."));
  });

  it("updateByAgent refuses another agent's, a person's and the agent's own record", async () => {
    const { roomId, member, admin } = await room();
    const maker = await agents.create(member, roomId, scout);
    const other = await agents.create(member, roomId, { ...scout, name: "other" });
    const theirs = await agents.createByAgent(roomId, { ...scout, name: "theirs" }, { agentId: other.agentId, name: "other" });
    const refused = new Forbidden("An agent can edit only the agents it created, never itself.");
    for (const agentId of [theirs.agentId, other.agentId, maker.agentId, "agent"]) {
      await expect(agents.updateByAgent(roomId, agentId, { instructions: "x" }, maker.agentId)).rejects.toEqual(refused);
    }
    const mine = await agents.createByAgent(roomId, { ...scout, name: "mine" }, { agentId: maker.agentId, name: "scout" });
    await agents.remove(admin, roomId, mine.agentId);
    await expect(agents.updateByAgent(roomId, mine.agentId, { instructions: "x" }, maker.agentId)).rejects.toEqual(new NotFound("No such agent."));
  });

  it("refuses someone outside the room", async () => {
    const { roomId } = await room();
    await expect(agents.create(user("eve"), roomId, scout)).rejects.toEqual(new NotFound("Room not found."));
  });
});
