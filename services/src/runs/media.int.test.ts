import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { chatRepo } from "../chat/repo.js";
import { docClient, queryAll, tableName } from "../lib/db.js";
import { pushRepo } from "../push/repo.js";
import { roomsRepo } from "../rooms/repo.js";
import { threadsRepo } from "../threads/repo.js";
import { workspaceRepo } from "../workspace/repo.js";
import { runsRepo } from "./repo.js";
import { startOrSteer } from "./start.js";
import { requestStop } from "./stop.js";

// Runs against the deployed run and push functions on Floci, in fake model, tool and push modes: npm run deploy:local,
// then this file.
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";
process.env.PUSH_FN_NAME = "cl-local-push";
process.env.MODEL_GATEWAY = "fake";

const runs = runsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let clients = 0;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** A device as a browser makes one: a fresh P-256 key and auth secret. */
function device() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

/** The notes the fake push service recorded for a user, once there are `count` of them. */
const pushedTo = (userId: string, count = 1) =>
  until(`${count} push(es) to ${userId}`, async () => {
    const items = await queryAll({
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ConsistentRead: true,
      ExpressionAttributeValues: { ":p": `USER#${userId}`, ":s": "PUSHED#" },
    });
    return items.length >= count ? items.map((i) => i.note as { title: string; body: string; url: string }) : undefined;
  });

/** A room with aman as owner and bea as a member, each with a device subscribed, and a GitHub connection. */
async function room() {
  const aman = user("aman");
  const bea = user("bea");
  const rooms = roomsRepo();
  const { roomId, generalChatId } = await rooms.createRoom(aman, "Media");
  await rooms.acceptInvite((await rooms.rotateInvite(roomId, aman.userId)).code, bea);
  await Promise.all([pushRepo().save(aman.userId, device()), pushRepo().save(bea.userId, device())]);
  await docClient().send(new PutCommand({
    TableName: tableName(),
    Item: {
      pk: `ROOM#${roomId}`, sk: "CONN#github", installationId: 1, account: "fake-org", repos: ["fake-org/playground"],
      addedBy: "aman", addedAt: new Date().toISOString(),
    },
  }));
  return { aman, bea, roomId, generalChatId };
}

async function startRun(text: string, at: Awaited<ReturnType<typeof room>>) {
  const { thread, message } = await threadsRepo().createThread(at.aman, at.roomId, { text, clientId: `k${++clients}` });
  return { thread, ...await startOrSteer(at.aman, at.roomId, thread.threadId, message) };
}

const finished = (runId: string) =>
  until("the run to end", async () => {
    const run = await runs.getRun(runId);
    if (!run || run.status === "running") return undefined;
    return (await runs.allEvents(runId)).at(-1)?.type === "run.finished" ? run : undefined;
  });

describe("images and pushes, on Floci", { timeout: 60_000 }, () => {
  it("an image is billed once, saved as a room file and listed on the answer, and the starter hears the run finished", async () => {
    const at = await room();
    const { thread, runId } = await startRun("go call:image_generate", at);
    const run = await finished(runId);
    expect(run.status).toBe("done");

    const path = `images/${thread.number}-${run.firstSeq}-1-fake.png`;
    expect((await workspaceRepo().list(at.roomId)).map((f) => f.path)).toContain(path);
    const events = await runs.allEvents(runId);
    expect(events.filter((e) => e.type === "step.finished")).toMatchObject([{ step: 1, ok: true, image: { path, aspect: "1:1" } }]);
    expect(events.filter((e) => e.type === "usage" && e.job === "image")).toMatchObject([{ step: 1, costMicros: 67_205 }]);
    const answer = (await chatRepo().history(at.aman, at.roomId, thread.threadId, {})).messages.find((m) => m.authorId === "agent");
    expect(answer?.agent?.images).toEqual([{ path, aspect: "1:1" }]);

    const named = (await threadsRepo().threadById(at.roomId, thread.threadId))!.name;
    expect((await pushedTo(at.aman.userId)).map((n) => n.title)).toEqual([`#${named} finished`]);
  });

  it("a second run in the thread saves its own image and leaves the first one", async () => {
    const at = await room();
    const first = await startRun("go call:image_generate", at);
    await finished(first.runId);
    const again = await chatRepo().send(at.aman, {
      roomId: at.roomId, chatId: first.thread.threadId, clientId: `k${++clients}`, text: "again call:image_generate",
    });
    const second = await startOrSteer(at.aman, at.roomId, first.thread.threadId, again);
    await finished(second.runId);

    const paths = (await workspaceRepo().list(at.roomId)).map((f) => f.path).filter((p) => p.startsWith("images/"));
    expect(paths).toHaveLength(2);
  });

  it("a mention reaches the member it names", async () => {
    const at = await room();
    await chatRepo().send(at.bea, { roomId: at.roomId, chatId: at.generalChatId, clientId: "m1", text: "@aman hi" });
    expect(await pushedTo(at.aman.userId)).toMatchObject([{ title: "bea mentioned you in #general", body: "Media: @aman hi" }]);
  });

  it("an approval reaches every member of the room", async () => {
    const at = await room();
    const { thread, runId } = await startRun("go call:github_comment", at);
    const [aman, bea] = await Promise.all([pushedTo(at.aman.userId), pushedTo(at.bea.userId)]);
    const named = (await threadsRepo().threadById(at.roomId, thread.threadId))!.name;
    expect([aman, bea].map((notes) => notes.map((n) => n.title))).toEqual([[`#${named} needs approval`], [`#${named} needs approval`]]);
    await requestStop(at.aman, at.roomId, thread.threadId);
    await finished(runId);
  });
});
