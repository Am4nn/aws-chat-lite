import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Forbidden } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { schedulesRepo } from "../schedules/repo.js";
import { copyAgent } from "./copy.js";
import { agentsRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const rooms = roomsRepo();
const agents = agentsRepo();
const schedules = schedulesRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const scout = { name: "scout", instructions: "Find things.", tools: ["github" as const, "web" as const], model: "haiku" as const };

/** Ann owns both rooms; Bob is a member of both and made `scout` in the first, with a schedule. */
async function rooms2() {
  const ann = user("ann");
  const bob = user("bob");
  const from = await rooms.createRoom(ann, "From");
  const to = await rooms.createRoom(ann, "To");
  for (const { roomId } of [from, to]) await rooms.acceptInvite((await rooms.rotateInvite(roomId, ann.userId)).code, bob);
  const made = await agents.create(bob, from.roomId, scout);
  await schedules.create(bob, from.roomId, {
    agentId: made.agentId, title: "Morning digest", prompt: "Digest the new issues.", cadence: { kind: "daily", time: "09:00" }, chatId: from.generalChatId,
  });
  return { ann, bob, from, to, made };
}

describe("copyAgent on Floci", () => {
  it("only into a room the caller admins", async () => {
    const { bob, from, to, made } = await rooms2();
    await expect(copyAgent(bob, { roomId: from.roomId, agentId: made.agentId }, to.roomId))
      .rejects.toEqual(new Forbidden("You can copy agents only into rooms where you're an admin."));
    expect((await agents.list(to.roomId)).map((a) => a.name)).toEqual(["agent"]);
  });

  it("maps the kinds, takes the next free name, and brings the schedules switched off into the oldest chat", async () => {
    const { ann, from, to, made } = await rooms2();
    await agents.create(ann, to.roomId, { ...scout, name: "scout", tools: ["web"] });
    const copy = await copyAgent(ann, { roomId: from.roomId, agentId: made.agentId }, to.roomId);
    expect(copy).toMatchObject({
      agent: { name: "scout-2", tools: ["web"], model: "haiku", createdBy: ann.userId }, dropped: ["github"], schedules: { copied: 1, skipped: 0 },
    });
    const [copied] = (await schedules.list(ann, to.roomId)).schedules;
    expect(copied).toMatchObject({ agentId: copy.agent.agentId, title: "Morning digest", enabled: false, chatId: to.generalChatId, createdBy: ann.userId });
  });
});
