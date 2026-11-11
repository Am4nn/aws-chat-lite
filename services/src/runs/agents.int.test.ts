import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { agentsRepo } from "../agents/repo.js";
import { auditRepo } from "../audit/repo.js";
import { chatRepo } from "../chat/repo.js";
import type { Attachment } from "../chat/model.js";
import { memoryRepo } from "../memory/repo.js";
import { roomsRepo } from "../rooms/repo.js";
import { threadsRepo } from "../threads/repo.js";
import { routeSend } from "../threads/route.js";
import type { Agent, RunEvent, ToolKind } from "../threads/types.js";
import { runsRepo } from "./repo.js";
import { startOrSteer } from "./start.js";

// Runs against the deployed run function on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";

const runs = runsRepo();
const chat = chatRepo();
const threads = threadsRepo();
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

/** The run once it has closed and written `run.finished`, which follows the close. */
const finished = (runId: string) =>
  until("the run to end", async () => {
    const run = await runs.getRun(runId);
    if (!run || run.status === "running") return undefined;
    return (await runs.allEvents(runId)).at(-1)?.type === "run.finished" ? run : undefined;
  });

const answerOf = async (owner: { userId: string; username: string }, roomId: string, threadId: string) =>
  (await chat.history(owner, roomId, threadId, {})).messages.filter((m) => m.authorId === "agent").at(-1)?.text ?? "";
const ofType = <T extends RunEvent["type"]>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

/** A room with `scout`, an agent of the given kinds and model. */
async function roomWithScout(tools: ToolKind[] = ["web"], model: Agent["model"] = "room") {
  const owner = { userId: randomUUID(), username: "owner" };
  const { roomId, generalChatId } = await roomsRepo().createRoom(owner, "Agents");
  const scout = await agentsRepo().create(owner, roomId, { name: "scout", instructions: "Scout the web.", tools, model });
  return { owner, roomId, generalChatId, scout };
}

/** A thread of scout's whose first message (with any files, as already checked) starts a run. */
async function scoutRun(at: Awaited<ReturnType<typeof roomWithScout>>, text: string, attachments: Attachment[] = []) {
  const { thread, message } = await threads.createThread(at.owner, at.roomId, {
    text, clientId: `k${++clients}`, admitted: { text, attachments }, agentId: at.scout.agentId,
  });
  const { runId } = await startOrSteer(at.owner, at.roomId, thread.threadId, message);
  return { thread, runId, run: await finished(runId), events: await runs.allEvents(runId) };
}

const file: Attachment = { key: "rooms/r/u/f/report.pdf", name: "report.pdf", size: 1, type: "application/pdf" };

// Each durable step checkpoints through Floci, which takes up to a second or two while other suites share it.
describe("room agents and memory in the run loop on Floci", { timeout: 90_000 }, () => {
  it("@scout in a people chat starts scout's thread, links the card and runs to done", async () => {
    const at = await roomWithScout();
    const { route } = await routeSend(at.owner, { roomId: at.roomId, chatId: at.generalChatId, clientId: `k${++clients}`, text: "@scout go tools:0" });
    await route();
    const card = (await chat.history(at.owner, at.roomId, at.generalChatId, {})).messages.at(-1)!;
    expect(card.threadRef).toMatchObject({ kind: "started" });
    const thread = (await threads.threadById(at.roomId, card.threadRef!.threadId))!;
    expect(thread.agentId).toBe(at.scout.agentId);
    expect((await finished(thread.runId!)).status).toBe("done");
  });

  it("scout's own model answers when the message picks none; every model call says how long it took", async () => {
    const at = await roomWithScout(["web"], "haiku");
    const { run, events } = await scoutRun(at, "go tools:0");
    expect(run).toMatchObject({ status: "done", agentId: at.scout.agentId, pick: "haiku", pickBy: "default" });
    expect(ofType(events, "routed")[0]).toMatchObject({ model: "claude-haiku-5-5", by: "default" });
    const usage = ofType(events, "usage").filter((e) => e.job === "run");
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) expect(u.ms).toBeGreaterThanOrEqual(0);
  });

  it("an agent gets only its kinds: scout with web can't reach the sandbox, and its web search is one step", async () => {
    const at = await roomWithScout(["web"]);
    const sandbox = await scoutRun(at, "go call:sandbox_run");
    expect(sandbox.run.status).toBe("done");
    expect(ofType(sandbox.events, "step.started")).toEqual([]);

    const search = await scoutRun(at, "go call:web_search");
    expect(search.run.status).toBe("done");
    expect(ofType(search.events, "step.started").map((e) => e.call.name)).toEqual(["web_search"]);
  });

  it("memory_save keeps scout's name and the thread, and an entry saved from a thread with a file is private", async () => {
    const at = await roomWithScout();
    const plain = await scoutRun(at, "go call:memory_save");
    expect(ofType(plain.events, "step.finished")[0]).toMatchObject({ ok: true, output: expect.stringMatching(/^Saved to room memory as \[[0-9a-f]{8}\]; from your next turn it is listed in the room memory\.$/) });
    const [saved] = await memoryRepo().entries(at.roomId);
    expect(saved).toMatchObject({ private: false, source: { kind: "agent", agent: "scout", threadNumber: plain.thread.number } });

    const withFile = await scoutRun(at, "go call:memory_save", [file]);
    expect(withFile.run.status).toBe("done");
    const entries = await memoryRepo().entries(at.roomId);
    expect(entries.find((e) => e.source.kind === "agent" && e.source.threadNumber === withFile.thread.number)).toMatchObject({ private: true });
  });

  it("what one run saves, the next run sees in its prompt", async () => {
    const at = await roomWithScout();
    await scoutRun(at, "go call:memory_save");
    const [saved] = await memoryRepo().entries(at.roomId);
    const recall = await scoutRun(at, "recall tools:0");
    expect(recall.run.status).toBe("done");
    expect(await answerOf(at.owner, at.roomId, recall.thread.threadId)).toContain(`[${saved!.memoryId}] ${saved!.text}`);
  });

  it("a private entry reaches only threads that are already private, so a clean thread never holds it", async () => {
    const at = await roomWithScout();
    await scoutRun(at, "go call:memory_save", [file]);
    const [secret] = await memoryRepo().entries(at.roomId);
    expect(secret).toMatchObject({ private: true });
    const clean = await scoutRun(at, "recall tools:0");
    expect(await answerOf(at.owner, at.roomId, clean.thread.threadId)).not.toContain(`[${secret!.memoryId}]`);
    const tainted = await scoutRun(at, "recall tools:0", [file]);
    expect(await answerOf(at.owner, at.roomId, tainted.thread.threadId)).toContain(`[${secret!.memoryId}] ${secret!.text}`);
  });

  it("a deleted agent's thread is answered by the built-in @agent from its next run", async () => {
    const at = await roomWithScout();
    const first = await scoutRun(at, "go tools:0");
    expect(first.run.agentId).toBe(at.scout.agentId);
    await agentsRepo().remove(at.owner, at.roomId, at.scout.agentId);
    const text = "again tools:0";
    const message = await chat.send(at.owner, { roomId: at.roomId, chatId: first.thread.threadId, clientId: `k${++clients}`, text });
    const { runId } = await startOrSteer(at.owner, at.roomId, first.thread.threadId, message);
    expect(await finished(runId)).toMatchObject({ status: "done", agentId: "agent" });
  });

  it("the audit names the agent that was asked and the one that called the tool", async () => {
    const at = await roomWithScout();
    const { thread } = await scoutRun(at, "go call:web_search");
    const { entries } = await auditRepo().list(at.roomId);
    const mine = entries.filter((e) => e.threadNumber === thread.number);
    expect(mine.find((e) => e.kind === "asked")).toMatchObject({ actor: "owner", agent: "scout" });
    expect(mine.find((e) => e.kind === "tool")).toMatchObject({ tool: "web_search", agent: "scout" });
  });

  it("a thread made with a name is named from the start, taking name-2 when the name is taken", async () => {
    const at = await roomWithScout();
    const make = (name: string) =>
      threads.createThread(at.owner, at.roomId, { text: "digest", clientId: `k${++clients}`, agentId: at.scout.agentId, name });
    const first = await make("morning-digest-nov-10");
    const second = await make("morning-digest-nov-10");
    expect(first.thread).toMatchObject({ name: "morning-digest-nov-10", agentId: at.scout.agentId });
    expect(second.thread.name).toBe("morning-digest-nov-10-2");
    expect((await threads.threadByTag(at.roomId, { name: "morning-digest-nov-10-2" }))?.threadId).toBe(second.thread.threadId);
  });
});
