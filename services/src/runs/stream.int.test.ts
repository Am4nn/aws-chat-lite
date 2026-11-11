import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { NotFound } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEvent } from "../threads/types.js";
import { runsRepo, type Run } from "./repo.js";
import { startOrSteer } from "./start.js";
import { startStreamServer } from "./stream-server.js";
import { consumeStreamTicket, issueStreamTicket } from "./stream-tickets.js";

// Runs against DynamoDB and the deployed run function on Floci: npm run floci:up && npm run deploy:local, then
// npm -w services run test:int
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";

const runs = runsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
let clients = 0;

/**
 * A run with its event log already written straight to the table: finished (run.finished last), or `dead`, still
 * marked running 131 minutes after it started, with no run.finished.
 */
async function storedRun(texts: string[], { dead = false } = {}) {
  const owner = user("owner");
  const { roomId } = await roomsRepo().createRoom(owner, "Streams");
  const { thread, message } = await threadsRepo().createThread(owner, roomId, { text: "go", clientId: `k${++clients}` });
  const run: Run = {
    runId: randomUUID(), roomId, threadId: thread.threadId, number: thread.number, status: dead ? "running" : "done",
    model: "fake", startedBy: owner.username, startedAt: new Date(Date.now() - (dead ? 131 * 60_000 : 0)).toISOString(), firstSeq: message.seq, seenSeq: message.seq, steps: 0, costMicros: 0,
  };
  await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `RUN#${run.runId}`, sk: "META", ...run } }));
  const writer = await runs.eventWriter(run.runId);
  await writer.append({ type: "run.started", model: "fake", startedBy: owner.username });
  for (const text of texts) await writer.append({ type: "text", text });
  if (!dead) await writer.append({ type: "run.finished", status: "done", ms: 5, steps: 0, costMicros: 0 });
  return { owner, roomId, run };
}

let server: ReturnType<typeof startStreamServer>;
let base: string;
beforeAll(async () => {
  server = startStreamServer(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const streamUrl = async (u: { userId: string; username: string }, runId: string) =>
  `${base}/runs/${runId}/stream?ticket=${(await issueStreamTicket(u, runId)).ticket}`;

/** Every event in an SSE body, in order. */
const parse = (body: string): RunEvent[] => [...body.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!));

/** Reads a stream until it ends, or until `dropWhen` holds for the events so far, when it hangs up like a dropped client. */
async function read(url: string, opts: { lastEventId?: number; dropWhen?: (events: RunEvent[]) => boolean } = {}) {
  const gone = new AbortController();
  const res = await fetch(url, { headers: opts.lastEventId ? { "last-event-id": String(opts.lastEventId) } : {}, signal: gone.signal });
  let body = "";
  const dec = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      body += dec.decode(chunk, { stream: true });
      // Only whole frames count; a partial one is lost with the connection, as it would be in a browser.
      if (opts.dropWhen?.(parse(body.slice(0, body.lastIndexOf("\n\n") + 2)))) {
        gone.abort();
        break;
      }
    }
  } catch (e) {
    if (!gone.signal.aborted) throw e;
  }
  return { res, events: parse(body.slice(0, body.lastIndexOf("\n\n") + 2)) };
}

describe("stream tickets on Floci", () => {
  it("only a member of the run's room gets a ticket", async () => {
    const { run } = await storedRun(["hi"]);
    await expect(issueStreamTicket(user("stranger"), run.runId)).rejects.toBeInstanceOf(NotFound);
    await expect(issueStreamTicket(user("stranger"), randomUUID())).rejects.toBeInstanceOf(NotFound);
  });

  it("a ticket opens its own run's stream, once", async () => {
    const { owner, roomId, run } = await storedRun(["hi"]);
    const { ticket } = await issueStreamTicket(owner, run.runId);
    expect(await consumeStreamTicket(ticket, randomUUID())).toBeNull();
    expect(await consumeStreamTicket(ticket, run.runId)).toEqual({ userId: owner.userId, roomId });
    expect(await consumeStreamTicket(ticket, run.runId)).toBeNull();
  });
});

describe("local stream server on Floci", () => {
  it("streams a finished run's every event and closes; Last-Event-ID: 2 starts from 3", async () => {
    const { owner, run } = await storedRun(["Hello ", "world."]);
    const all = await read(await streamUrl(owner, run.runId));
    expect(all.res.status).toBe(200);
    expect(all.res.headers.get("content-type")).toBe("text/event-stream");
    expect(all.res.headers.get("access-control-allow-origin")).toBe("*");
    expect(all.events.map((e) => [e.seq, e.type])).toEqual([[1, "run.started"], [2, "text"], [3, "text"], [4, "run.finished"]]);

    const resumed = await read(await streamUrl(owner, run.runId), { lastEventId: 2 });
    expect(resumed.events.map((e) => e.seq)).toEqual([3, 4]);
  });

  it("a used or missing ticket is a 401; a preflight gets the CORS headers", async () => {
    const { owner, run } = await storedRun(["hi"]);
    const url = await streamUrl(owner, run.runId);
    await read(url);
    const used = await fetch(url);
    expect(used.status).toBe(401);
    expect(used.headers.get("content-type")).toBe("application/json");
    expect(await used.json()).toEqual({ error: expect.any(String) });
    expect((await fetch(`${base}/runs/${run.runId}/stream`)).status).toBe(401);
    const preflight = await fetch(url, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toBe("last-event-id");
  });

  it("a member removed after the ticket was issued gets a 404 at connect", async () => {
    const { owner, roomId, run } = await storedRun(["hi"]);
    const member = user("member");
    await roomsRepo().acceptInvite((await roomsRepo().rotateInvite(roomId, owner.userId)).code, member);
    const url = await streamUrl(member, run.runId);
    await roomsRepo().removeMember(roomId, owner.userId, member.userId);
    expect((await fetch(url)).status).toBe(404);
  });

  it("a dead run streams what is left; once nothing is, a reconnect gets 410", async () => {
    const { owner, run } = await storedRun(["hi"], { dead: true });
    const resumed = await read(await streamUrl(owner, run.runId), { lastEventId: 1, dropWhen: (events) => events.length >= 1 });
    expect(resumed.events.map((e) => e.seq)).toEqual([2]);
    expect((await fetch(await streamUrl(owner, run.runId), { headers: { "last-event-id": "2" } })).status).toBe(410);
  });

  it("a live answer dropped mid-stream and resumed with Last-Event-ID equals the stored answer exactly", async () => {
    const owner = user("owner");
    const { roomId } = await roomsRepo().createRoom(owner, "Resume");
    const { thread, message } = await threadsRepo().createThread(owner, roomId, { text: "go slow tools:0 words:30", clientId: `k${++clients}` });
    const { runId } = await startOrSteer(owner, roomId, thread.threadId, message);

    const texts = (events: RunEvent[]) => events.filter((e) => e.type === "text").length;
    const first = await read(await streamUrl(owner, runId), { dropWhen: (events) => texts(events) >= 2 });
    expect(texts(first.events)).toBeGreaterThanOrEqual(2);
    expect(first.events.at(-1)!.type).not.toBe("run.finished");

    const rest = await read(await streamUrl(owner, runId), { lastEventId: first.events.at(-1)!.seq });
    const seen = [...first.events, ...rest.events];
    expect(seen.at(-1)!.type).toBe("run.finished");
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));

    const shown = seen.flatMap((e) => (e.type === "text" ? e.text : [])).join("");
    const { messages } = await chatRepo().history(owner, roomId, thread.threadId, {});
    const answer = messages.find((m) => m.authorId === "agent");
    expect(answer?.text).toBe(shown);
    expect(shown.length).toBeGreaterThan(0);
  }, 60_000);
});
