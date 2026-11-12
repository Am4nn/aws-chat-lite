import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { auditRepo } from "../audit/repo.js";
import { FlowFailed, Forbidden, Gone } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { connectionsRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const repo = connectionsRepo();
const rooms = roomsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const REDIRECT = "http://localhost:3000/bff/github/callback";
const acme = [{ id: 7, account: "acme", repos: ["acme/api", "acme/web"] }];

/** Signs `admin` in with GitHub in `roomId`, with a stand-in for the code exchange that can reach acme. */
async function signIn(admin: ReturnType<typeof user>, roomId: string) {
  const { state } = await repo.startGitHubSignIn(admin, roomId, REDIRECT);
  return repo.finishGitHubSignIn(admin, { state, code: "c" }, async () => acme);
}

async function room() {
  const owner = user("owner");
  const member = user("member");
  const { roomId } = await rooms.createRoom(owner, "Tools");
  await rooms.acceptInvite((await rooms.rotateInvite(roomId, owner.userId)).code, member);
  return { owner, member, roomId };
}

const kinds = async (roomId: string) => (await auditRepo().list(roomId)).entries.map((e) => e.kind);

describe("connections repo on Floci", () => {
  it("connect, then get returns it; disconnect, then null; each change leaves one audit entry", async () => {
    const { owner, roomId } = await room();
    expect((await repo.get(roomId)).github).toBeNull();
    await signIn(owner, roomId);
    const github = await repo.setGitHub(owner, roomId, { installationId: 7, repos: ["acme/web"] });
    expect((await repo.get(roomId)).github).toEqual(github);
    expect(github).toMatchObject({ installationId: 7, account: "acme", repos: ["acme/web"], addedBy: "owner" });
    expect(await kinds(roomId)).toEqual(["connected"]);
    await repo.removeGitHub(owner, roomId);
    expect((await repo.get(roomId)).github).toBeNull();
    expect(await kinds(roomId)).toEqual(["disconnected", "connected"]);
    await repo.removeGitHub(owner, roomId);
    expect(await kinds(roomId)).toHaveLength(2);
  });

  it("the timeout defaults to 2 hours and round-trips as seconds", async () => {
    const { owner, roomId } = await room();
    expect((await repo.get(roomId)).approvalTimeoutSec).toBe(7200);
    expect(await repo.setApprovalTimeout(owner, roomId, 30)).toBe(30);
    expect((await repo.get(roomId)).approvalTimeoutSec).toBe(1800);
    const [entry] = (await auditRepo().list(roomId)).entries;
    expect(entry).toMatchObject({ kind: "timeout", actor: "owner", detail: "30 min" });
  });

  it("a member changes nothing, and nothing is logged", async () => {
    const { member, roomId } = await room();
    await expect(repo.setApprovalTimeout(member, roomId, 30)).rejects.toBeInstanceOf(Forbidden);
    await expect(repo.setGitHub(member, roomId, { installationId: 7, repos: ["acme/web"] })).rejects.toBeInstanceOf(Forbidden);
    expect(await repo.view(roomId, member.userId)).toMatchObject({ github: null, approvalTimeoutSec: 7200, canManage: false });
    expect(await kinds(roomId)).toEqual([]);
  });

  it("a GitHub sign-in's state works once and only for its admin, and its grant only in its room", async () => {
    const { owner, member, roomId } = await room();
    const { state } = await repo.startGitHubSignIn(owner, roomId, REDIRECT);
    const finish = (who: ReturnType<typeof user>) => repo.finishGitHubSignIn(who, { state, code: "c" }, async () => acme);
    await expect(finish(member)).rejects.toBeInstanceOf(FlowFailed);
    await expect(repo.installations(roomId, owner.userId)).rejects.toBeInstanceOf(Gone);
    // The member's try left the state for its admin, who uses it up.
    expect(await finish(owner)).toEqual({ roomId });
    await expect(finish(owner)).rejects.toBeInstanceOf(Gone);
    expect(await repo.installations(roomId, owner.userId)).toEqual(acme);
    const { roomId: second } = await rooms.createRoom(owner, "Second");
    await expect(repo.setGitHub(owner, second, { installationId: 7, repos: ["acme/web"] })).rejects.toBeInstanceOf(Gone);
  });
});
