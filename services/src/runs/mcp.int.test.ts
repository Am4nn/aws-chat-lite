import { randomUUID } from "node:crypto";
import type dns from "node:dns";
import { readFileSync } from "node:fs";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, describe, expect, it } from "vitest";
import { decideApproval } from "../approvals/decide.js";
import { connectionsRepo } from "../connections/repo.js";
import { docClient, tableName } from "../lib/db.js";
import { connectTestServer } from "../mcp/testing/connect.js";
import { startMcpTestServer } from "../mcp/testing/server.js";
import type { ModelPick } from "../models/catalog.js";
import { roomsRepo } from "../rooms/repo.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEvent } from "../threads/types.js";
import { runsRepo } from "./repo.js";
import { startOrSteer } from "./start.js";

// Runs against the deployed run function on Floci, in fake model and tool modes: npm run deploy:local, then this file.
// The run function reaches the test servers on this machine at host.docker.internal, which MCP_LOCAL_HOSTS allows
// on the local stage only. The ports are clear of the dev server's 4710, so `npm run dev` can stay up.
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";
process.env.MODEL_GATEWAY = "fake";

const LOCAL_HOSTS = ["host.docker.internal", "127.0.0.1"];
const RECONNECT = "test needs reconnecting. An admin can reconnect it in the room panel.";
const runs = runsRepo();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const user = (name: string) => ({ userId: randomUUID(), username: name });
let clients = 0;

/** This process connects the room as its admin, so it resolves the name the run function uses to this machine. */
const toLoopback = ((_host: string, options: unknown, callback: (...args: unknown[]) => void) => {
  const cb = typeof options === "function" ? options : callback;
  const all = typeof options === "object" && options !== null && (options as dns.LookupOptions).all;
  return all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
}) as unknown as typeof dns.lookup;

const servers: { close(): Promise<void> }[] = [];
afterAll(() => Promise.all(servers.map((s) => s.close())));

async function testServer(port: number, accessTtlSec?: number) {
  const server = await startMcpTestServer({ port, origin: `http://host.docker.internal:${port}`, accessTtlSec });
  servers.push(server);
  return server;
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const finished = (runId: string) =>
  until("the run to end", async () => {
    const run = await runs.getRun(runId);
    if (!run || run.status === "running") return undefined;
    return (await runs.allEvents(runId)).at(-1)?.type === "run.finished" ? run : undefined;
  });

const eventsOf = (runId: string, type: RunEvent["type"]) => runs.allEvents(runId).then((all) => all.filter((e) => e.type === type));

/** A room with aman as owner and bea as a member, connected to `server` as `test` the way an admin connects one. */
async function room(server: Awaited<ReturnType<typeof testServer>>) {
  const aman = user("aman");
  const bea = user("bea");
  const rooms = roomsRepo();
  const { roomId } = await rooms.createRoom(aman, "MCP");
  await rooms.acceptInvite((await rooms.rotateInvite(roomId, aman.userId)).code, bea);
  await connectTestServer(roomId, aman, { serverUrl: server.url, lookup: toLoopback, localHosts: LOCAL_HOSTS });
  return { aman, bea, roomId };
}

async function startRun(text: string, at: Awaited<ReturnType<typeof room>>, pick?: ModelPick) {
  const { thread, message } = await threadsRepo().createThread(at.aman, at.roomId, { text, clientId: `k${++clients}` });
  const started = await startOrSteer(at.aman, at.roomId, thread.threadId, message, pick);
  return { thread, ...started };
}

const authVersion = async (roomId: string) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: "MCPAUTH#test" }, ConsistentRead: true })))
    .Item?.version as number | undefined;

describe("room MCP tools in the run loop, on Floci", { timeout: 60_000 }, () => {
  it("a read-only tool runs without asking, signed in as the room, and makes the thread private", async () => {
    const server = await testServer(4721);
    const at = await room(server);
    const { thread, runId } = await startRun("go call:mcp__test__echo", at);
    expect((await finished(runId)).status).toBe("done");
    expect(await eventsOf(runId, "approval.requested")).toEqual([]);
    expect(await eventsOf(runId, "step.finished")).toMatchObject([{ ok: true, output: "echo: fake" }]);
    expect((await threadsRepo().threadById(at.roomId, thread.threadId))!.taint).toContain("mcp");
    expect(server.calls).toContainEqual({ tool: "echo", input: { text: "fake" }, sub: "tester" });
  });

  it("a tool not marked read-only waits for a member, then runs once with the input the card showed", async () => {
    const server = await testServer(4722);
    const at = await room(server);
    const { thread, runId } = await startRun("go call:mcp__test__add_note", at);
    const waiting = await until("the thread to wait", async () => {
      const t = await threadsRepo().threadById(at.roomId, thread.threadId);
      return t?.status === "waiting" ? t : undefined;
    });
    expect(waiting.approval).toMatchObject({ step: 1, title: "Run add_note on test?" });
    await decideApproval(at.bea, runId, 1, "approve");
    expect((await finished(runId)).status).toBe("done");
    const [requested] = await eventsOf(runId, "approval.requested");
    const notes = server.calls.filter((c) => c.tool === "add_note");
    expect(notes).toHaveLength(1);
    expect(notes[0].input).toEqual(requested.type === "approval.requested" && requested.call.input);

    const denied = await startRun("go call:mcp__test__add_note", at);
    await until("the second thread to wait", async () =>
      (await threadsRepo().threadById(at.roomId, denied.thread.threadId))?.status === "waiting" || undefined);
    await decideApproval(at.bea, denied.runId, 1, "deny");
    await finished(denied.runId);
    expect(server.calls.filter((c) => c.tool === "add_note")).toHaveLength(1);
    expect(await eventsOf(denied.runId, "step.finished")).toMatchObject([{ ok: false, output: expect.stringMatching(/^Denied by/) }]);
  });

  it("a tool's error comes back as a failed step", async () => {
    const at = await room(await testServer(4723));
    const { runId } = await startRun("go call:mcp__test__fail", at);
    await finished(runId);
    expect(await eventsOf(runId, "step.finished")).toMatchObject([{ ok: false, output: "it failed" }]);
  });

  it("an expired access token is refreshed and saved before the call", async () => {
    const at = await room(await testServer(4724, 2));
    const before = await authVersion(at.roomId);
    await sleep(3000);
    const { runId } = await startRun("go call:mcp__test__echo", at);
    await finished(runId);
    expect(await eventsOf(runId, "step.finished")).toMatchObject([{ ok: true, output: "echo: fake" }]);
    expect(await authVersion(at.roomId)).toBeGreaterThan(before!);
  });

  it("a sign-in the server revoked asks for a reconnect, and the next turn offers the server's tools no more", async () => {
    const server = await testServer(4725);
    const at = await room(server);
    server.revokeAll();
    const { runId } = await startRun("go call:mcp__test__echo call:mcp__test__echo", at);
    await finished(runId);
    expect(await eventsOf(runId, "step.finished")).toMatchObject([{ ok: false, output: RECONNECT }]);
    expect((await connectionsRepo().get(at.roomId)).mcp).toMatchObject([{ name: "test", status: "needs_auth" }]);
  });

  it("DeepSeek isn't offered MCP tools", async () => {
    const server = await testServer(4726);
    const at = await room(server);
    const { runId } = await startRun("go call:mcp__test__echo", at, "deepseek-flash");
    expect((await finished(runId)).status).toBe("done");
    expect(await eventsOf(runId, "step.started")).toEqual([]);
    expect(server.calls).toEqual([]);
  });
});
