import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import type { ModelPick } from "../models/catalog.js";
import { dockerSandbox, runDocker } from "../sandbox/docker.js";
import { startSandboxServer } from "../sandbox/server.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEvent } from "../threads/types.js";
import { workspaceRepo } from "../workspace/repo.js";
import { getBytes, newObjectKey, putBytes } from "../workspace/storage.js";
import { runsRepo } from "./repo.js";
import { startOrSteer } from "./start.js";
import { requestStop } from "./stop.js";

// Runs against the deployed run function on Floci, which reaches the sandbox server on this machine through Docker:
// npm run floci:up && npm run sandbox:build && npm run deploy:local, then this file.
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";
const token = readFileSync(new URL("../../../.secrets/sandbox-token", import.meta.url), "utf8").trim();

const runs = runsRepo();
const files = workspaceRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let clients = 0;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const finished = (runId: string, ms?: number) =>
  until("the run to end", async () => {
    const run = await runs.getRun(runId);
    if (!run || run.status === "running") return undefined;
    return (await runs.allEvents(runId)).at(-1)?.type === "run.finished" ? run : undefined;
  }, ms);

const eventOf = (runId: string, match: (e: RunEvent) => boolean) =>
  until("an event", async () => (await runs.allEvents(runId)).find(match));

async function room() {
  const owner = user("owner");
  const { roomId } = await roomsRepo().createRoom(owner, "Sandbox");
  return { owner, roomId };
}

async function startRun(text: string, at?: Awaited<ReturnType<typeof room>>, pick?: ModelPick) {
  const { owner, roomId } = at ?? await room();
  const { thread, message } = await threadsRepo().createThread(owner, roomId, { text, clientId: `k${++clients}` });
  const started = await startOrSteer(owner, roomId, thread.threadId, message, pick);
  return { owner, roomId, thread, ...started };
}

const textOf = async (roomId: string, path: string) => {
  const file = await files.get(roomId, path);
  return file && new TextDecoder().decode(await getBytes(file.objectKey));
};
const sessionItem = async (runId: string) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `RUN#${runId}`, sk: "SANDBOX" }, ConsistentRead: true }))).Item;
const containersOf = async (runId: string) =>
  (await runDocker(["ps", "-q", "--filter", `label=cl-run=${runId}`])).stdout.toString().trim();
const synced = (events: RunEvent[], step: number) => events.find((e) => e.type === "files.synced" && e.step === step);
const output = (events: RunEvent[], step: number) =>
  events.flatMap((e) => (e.type === "step.finished" && e.step === step ? [e.output] : []))[0] ?? "";

let server: Server | undefined;
beforeAll(async () => {
  const listening = await fetch("http://127.0.0.1:4700/").then(() => true, () => false);
  if (!listening) {
    server = startSandboxServer(dockerSandbox(), { token });
    await new Promise((resolve) => server!.once("listening", resolve));
  }
});
afterAll(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

// Every sandbox step starts or reuses a container and checkpoints through Floci, so these take tens of seconds.
describe("sandbox_run in the run loop, on Floci and Docker", { timeout: 120_000 }, () => {
  it("runs code against the room's files, saves what it wrote as the thread's, taints the thread and bills each step", async () => {
    const { roomId, thread, runId } = await startRun("make sh`echo hi > hello.txt` sh`cat hello.txt`");
    expect((await finished(runId, 90_000)).status).toBe("done");
    const events = await runs.allEvents(runId);

    expect(synced(events, 1)).toMatchObject({ written: ["hello.txt"], deleted: [], notes: [] });
    expect(await files.get(roomId, "hello.txt")).toMatchObject({
      v: 1, size: 3, updatedBy: { kind: "thread", threadId: thread.threadId, number: thread.number },
    });
    expect(output(events, 2)).toMatch(/^exit 0 .*\n--- stdout\nhi$/);
    expect((await threadsRepo().threadById(roomId, thread.threadId))!.taint).toContain("sandbox");
    const billed = events.filter((e) => e.type === "usage" && e.job === "sandbox");
    expect(billed).toHaveLength(2);
    expect(billed[0]).toMatchObject({ model: "sandbox", inputTokens: 0, outputTokens: 0 });

    expect(await sessionItem(runId)).toBeUndefined();
    expect(await containersOf(runId)).toBe("");
  });

  it("never offers DeepSeek the sandbox: no step, no file and no taint", async () => {
    const { roomId, thread, runId } = await startRun("go sh`echo x > y`", undefined, "deepseek-flash");
    expect((await finished(runId)).status).toBe("done");
    const events = await runs.allEvents(runId);
    expect(events.some((e) => e.type === "step.started")).toBe(false);
    expect(events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("")).toMatch(/^\(no sandbox here\)/);
    expect(await files.get(roomId, "y")).toBeUndefined();
    expect((await threadsRepo().threadById(roomId, thread.threadId))!.taint).not.toContain("sandbox");
  });

  it("a Stop during a long step leaves no session and no container", async () => {
    const { owner, roomId, thread, runId } = await startRun("wait sh`sleep 20`");
    await eventOf(runId, (e) => e.type === "step.started");
    await until("the container", async () => (await containersOf(runId)) || undefined);
    await requestStop(owner, roomId, thread.threadId);
    expect((await finished(runId, 90_000)).status).toBe("stopped");
    expect(await sessionItem(runId)).toBeUndefined();
    expect(await containersOf(runId)).toBe("");
  });

  it("two threads writing one file: the last write wins, with a note naming the other thread", async () => {
    const at = await room();
    const a = await startRun("a sh`echo a > n.txt` sh`sleep 4` sh`echo a2 > n.txt`", at);
    await eventOf(a.runId, (e) => e.type === "step.started" && e.step === 2);
    const b = await startRun("b sh`echo b > n.txt`", at);
    expect((await finished(b.runId, 90_000)).status).toBe("done");
    expect((await finished(a.runId, 90_000)).status).toBe("done");

    const notes = (synced(await runs.allEvents(a.runId), 3) as { notes: string[] } | undefined)?.notes ?? [];
    expect(notes).toEqual([`n.txt was changed by #${b.thread.number} after this run loaded it; this run's version replaced it.`]);
    expect(await textOf(at.roomId, "n.txt")).toBe("a2\n");
  });

  it("a file a member adds between steps is in the sandbox for the next one", async () => {
    const at = await room();
    const { runId } = await startRun("read sh`sleep 3` sh`cat m.txt`", at);
    await eventOf(runId, (e) => e.type === "step.started" && e.step === 1);
    const objectKey = newObjectKey(at.roomId);
    await putBytes(objectKey, new TextEncoder().encode("from a member"), "text/plain");
    await files.commit(at.roomId, {
      path: "m.txt", objectKey, size: 13, contentType: "text/plain", by: { kind: "member", userId: at.owner.userId, name: "owner" },
    });
    expect((await finished(runId, 90_000)).status).toBe("done");
    expect(output(await runs.allEvents(runId), 2)).toContain("from a member");
  });
});
