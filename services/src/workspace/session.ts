import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { conditionFailed, docClient, tableName } from "../lib/db.js";
import { roomKey } from "../lib/keys.js";
import { broadcastToRoom } from "../live/broadcast.js";
import type { Run } from "../runs/repo.js";
import { sandbox } from "../sandbox/index.js";
import { LIST_CODE, parseListing } from "../sandbox/listing.js";
import { SandboxGone, type Language, type Sandbox } from "../sandbox/sandbox.js";
import { toolOutput } from "./output.js";
import { QuotaError, roomFile, workspaceRepo, type WorkspaceRepo } from "./repo.js";
import { deleteObjects, getBytes, newObjectKey, putBytes } from "./storage.js";
import { keptNote, overwroteNote, pullPlan, pushPlan, quotaNote } from "./sync.js";
import type { FileAuthor, FilesSynced, FilesUpdated, Manifest, RoomFile } from "./types.js";

/** The run's one sandbox session (the `SANDBOX` item), and what it last synced with the room. */
export type Session = { handle: string; internet: boolean; startedAt: string; synced: Manifest };

export interface SandboxDeps {
  /** A function, so a Lambda that only closes runs builds no sandbox client until a session exists. */
  sandbox: () => Sandbox;
  sessions: ReturnType<typeof sessionStore>;
  files: Pick<WorkspaceRepo, "list" | "usage" | "commit" | "remove">;
  storage: { getBytes: typeof getBytes; putBytes: typeof putBytes; deleteObjects: typeof deleteObjects };
  notify: (roomId: string, event: FilesUpdated) => Promise<unknown>;
}

type RunRef = Pick<Run, "runId" | "roomId" | "threadId" | "number">;
type SandboxCall = { language: Language; code: string; timeoutSec: number };
type Result = { output: string; ok: boolean; synced: FilesSynced };

const BAD_INPUT = "sandbox_run needs language (shell, python or javascript) and code.";
const LOST_TWICE = "The sandbox stopped unexpectedly. Try again.";
const LANGUAGES: Language[] = ["shell", "python", "javascript"];
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 300;
const LIST_TIMEOUT_SEC = 60;
/** Room files are read into memory a batch at a time on their way into the sandbox. */
const PULL_BATCH_BYTES = 8 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", svg: "image/svg+xml",
  py: "text/x-python", js: "text/javascript", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf",
};

const noChanges = (): FilesSynced => ({ written: [], deleted: [], notes: [] });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const contentTypeOf = (path: string) => CONTENT_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
const sessionKey = (runId: string) => ({ pk: `RUN#${runId}`, sk: "SANDBOX" });

export function sessionStore() {
  const db = docClient();
  const TableName = tableName();
  return {
    async get(runId: string): Promise<Session | undefined> {
      const { Item } = await db.send(new GetCommand({ TableName, Key: sessionKey(runId), ConsistentRead: true }));
      return Item && { handle: String(Item.handle), internet: !!Item.internet, startedAt: String(Item.startedAt), synced: Item.synced as Manifest };
    },
    /** False when the run already has a session: a retried step that opened one while an earlier attempt also did. */
    async create(runId: string, s: Session): Promise<boolean> {
      try {
        await db.send(new PutCommand({ TableName, Item: { ...sessionKey(runId), ...s }, ConditionExpression: "attribute_not_exists(pk)" }));
        return true;
      } catch (e) {
        if (conditionFailed(e)) return false;
        throw e;
      }
    },
    async saveSynced(runId: string, synced: Manifest): Promise<void> {
      await db.send(new UpdateCommand({
        TableName, Key: sessionKey(runId), UpdateExpression: "SET #synced = :s",
        ExpressionAttributeNames: { "#synced": "synced" }, ExpressionAttributeValues: { ":s": synced },
      }));
    },
    async remove(runId: string): Promise<void> {
      await db.send(new DeleteCommand({ TableName, Key: sessionKey(runId) }));
    },
    /** The room's internet switch, read when a session starts; a room that never set it stays offline. */
    async internet(roomId: string): Promise<boolean> {
      const { Item } = await db.send(new GetCommand({
        TableName, Key: { pk: roomKey(roomId), sk: "META" }, ConsistentRead: true,
        ProjectionExpression: "#i", ExpressionAttributeNames: { "#i": "sandboxInternet" },
      }));
      return Item?.sandboxInternet === true;
    },
  };
}

const defaultDeps = (): SandboxDeps => ({
  sandbox: () => sandbox(), sessions: sessionStore(), files: workspaceRepo(), storage: { getBytes, putBytes, deleteObjects }, notify: broadcastToRoom,
});

/** Once the room's files are right, a failed cleanup or broadcast is logged rather than failing the step. */
async function bestEffort(what: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (e) {
    console.error(`${what} failed`, e);
  }
}

function parseCall(input: unknown): SandboxCall | null {
  const i = (typeof input === "object" && input ? input : {}) as Record<string, unknown>;
  const timeoutSec = i.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const ok = LANGUAGES.includes(i.language as Language) && typeof i.code === "string"
    && Number.isInteger(timeoutSec) && (timeoutSec as number) >= 1 && (timeoutSec as number) <= MAX_TIMEOUT_SEC;
  return ok ? { language: i.language as Language, code: i.code as string, timeoutSec: timeoutSec as number } : null;
}

function bySize<T extends { size: number }>(items: T[], max: number): T[][] {
  const out: T[][] = [];
  let size = Infinity;
  for (const item of items) {
    if (size + item.size > max) {
      out.push([]);
      size = 0;
    }
    out.at(-1)!.push(item);
    size += item.size;
  }
  return out;
}

/**
 * The run's session, opened on its first use. The conditional put is what keeps a run to one session: an attempt that
 * loses it stops the session it just started and uses the stored one.
 */
async function openSession(run: RunRef, deps: SandboxDeps): Promise<Session> {
  const stored = await deps.sessions.get(run.runId);
  if (stored) return stored;
  const internet = await deps.sessions.internet(run.roomId);
  const handle = await deps.sandbox().start({ runId: run.runId, internet });
  const opened: Session = { handle, internet, startedAt: new Date().toISOString(), synced: {} };
  if (await deps.sessions.create(run.runId, opened)) return opened;
  await deps.sandbox().stop(handle);
  return (await deps.sessions.get(run.runId))!;
}

/** Writes into the sandbox the room files that changed since the session last synced; returns what it now holds. */
async function pull(roomId: string, session: Session, deps: SandboxDeps): Promise<Manifest> {
  const index = await deps.files.list(roomId);
  const plan = pullPlan(index, session.synced);
  const manifest: Manifest = Object.fromEntries(
    index.filter((f) => session.synced[f.path]?.v === f.v).map((f) => [f.path, session.synced[f.path]!]),
  );
  for (const batch of bySize(plan.write, PULL_BATCH_BYTES)) {
    const files = await Promise.all(batch.map(async (f) => ({ path: f.path, bytes: await deps.storage.getBytes(f.objectKey) })));
    await deps.sandbox().writeFiles(session.handle, files);
    files.forEach((f, i) => { manifest[f.path] = { v: batch[i]!.v, sha256: sha256(f.bytes) }; });
  }
  if (plan.remove.length) await deps.sandbox().removeFiles(session.handle, plan.remove);
  return manifest;
}

/**
 * Saves to the room what the code changed. Each file is a new object, committed over the version the room has now:
 * the last write wins, with a note when that overwrote a version the run didn't know. A delete applies only to the
 * known version, so a newer one someone else wrote is kept.
 */
async function push(run: RunRef, handle: string, loaded: Manifest, known: (path: string) => number | undefined, deps: SandboxDeps) {
  const box = deps.sandbox();
  const listing = parseListing((await box.exec(handle, { language: "python", code: LIST_CODE, timeoutSec: LIST_TIMEOUT_SEC })).stdout);
  const [index, usage] = await Promise.all([deps.files.list(run.roomId), deps.files.usage(run.roomId)]);
  const plan = pushPlan(listing, loaded, new Map(index.map((f) => [f.path, f])), usage);
  const manifest = { ...loaded };
  const synced: FilesSynced = { written: [], deleted: [], notes: plan.notes };
  const updated: RoomFile[] = [];
  const by: FileAuthor = { kind: "thread", threadId: run.threadId, number: run.number };

  for (const { path } of plan.put) {
    const [file] = await box.readFiles(handle, [path]);
    if (!file) continue;
    const objectKey = newObjectKey(run.roomId);
    const contentType = contentTypeOf(path);
    await deps.storage.putBytes(objectKey, file.bytes, contentType);
    let committed;
    try {
      committed = await deps.files.commit(run.roomId, { path, objectKey, size: file.bytes.length, contentType, by });
    } catch (e) {
      await bestEffort("dropping a refused object", () => deps.storage.deleteObjects([objectKey]));
      if (!(e instanceof QuotaError)) throw e;
      synced.notes.push(quotaNote(path, e.message));
      continue;
    }
    const { file: stored, replaced } = committed;
    if (replaced) {
      await bestEffort("deleting a replaced object", () => deps.storage.deleteObjects([replaced.objectKey]));
      if (replaced.v !== known(path)) synced.notes.push(overwroteNote(path, replaced.updatedBy));
    }
    manifest[path] = { v: stored.v, sha256: sha256(file.bytes) };
    synced.written.push(path);
    updated.push(roomFile(stored));
  }

  for (const { path } of plan.remove) {
    const { removed, kept } = await deps.files.remove(run.roomId, path, known(path));
    // Either way the sandbox no longer holds the room's version, so the next pull brings back a kept file.
    delete manifest[path];
    if (kept) synced.notes.push(keptNote(path, kept.updatedBy));
    if (removed) {
      await bestEffort("deleting a removed object", () => deps.storage.deleteObjects([removed.objectKey]));
      synced.deleted.push(path);
    }
  }
  return { synced, updated, manifest };
}

async function runInSession(run: RunRef, call: SandboxCall, session: Session, deps: SandboxDeps): Promise<Result> {
  const loaded = await pull(run.roomId, session, deps);
  // The version the run knew is the one its session held before this pull: the model wrote this step's code without
  // seeing a change pulled in just now. A file new to the session is known as pulled.
  const known = (path: string) => session.synced[path]?.v ?? loaded[path]?.v;
  const t0 = Date.now();
  const result = await deps.sandbox().exec(session.handle, call);
  const ms = Date.now() - t0;
  const { synced, updated, manifest } = await push(run, session.handle, loaded, known, deps);
  await deps.sessions.saveSynced(run.runId, manifest);
  if (synced.written.length || synced.deleted.length) {
    await bestEffort("files.updated broadcast", () =>
      deps.notify(run.roomId, { type: "files.updated", roomId: run.roomId, files: updated, deleted: synced.deleted }));
  }
  return { ok: result.exitCode === 0 && !result.timedOut, output: toolOutput(result, ms, synced), synced };
}

/**
 * One `sandbox_run` call: the room's files into the run's session, the code, then the changes back to the room. A
 * session that vanished (a crashed or reaped container, an expired AgentCore session) is replaced once, with a full
 * pull, and the code runs again in it.
 */
export async function runSandbox(run: RunRef, input: unknown, deps = defaultDeps()): Promise<Result> {
  const call = parseCall(input);
  if (!call) return { ok: false, output: BAD_INPUT, synced: noChanges() };
  for (let attempt = 1; ; attempt++) {
    const session = await openSession(run, deps);
    try {
      return await runInSession(run, call, session, deps);
    } catch (e) {
      if (!(e instanceof SandboxGone)) throw e;
      await deps.sessions.remove(run.runId);
      if (attempt === 2) return { ok: false, output: LOST_TWICE, synced: noChanges() };
    }
  }
}

/** Ends the run's session, if it has one. A session that can't be stopped is logged; it still ends at its own timeout. */
export async function closeSandbox(runId: string, deps: Pick<SandboxDeps, "sandbox" | "sessions"> = defaultDeps()): Promise<void> {
  const session = await deps.sessions.get(runId);
  if (!session) return;
  await bestEffort("stopping the sandbox", () => deps.sandbox().stop(session.handle));
  await deps.sessions.remove(runId);
}
