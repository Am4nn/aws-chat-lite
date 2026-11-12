import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { bySize } from "../lib/batches.js";
import { bestEffort } from "../lib/best-effort.js";
import { conditionFailed, docClient, tableName } from "../lib/db.js";
import { Conflict } from "../lib/errors.js";
import { roomMetaKey } from "../lib/keys.js";
import { broadcastToRoom } from "../live/broadcast.js";
import type { Run } from "../runs/repo.js";
import { sandbox } from "../sandbox/index.js";
import { LANGUAGES, MAX_TIMEOUT_SEC, SandboxGone, type ExecResult, type Language, type Sandbox, type WorkspaceFile } from "../sandbox/sandbox.js";
import { LIST_CODE, parseListing, removeCode, type Listing } from "../sandbox/scripts.js";
import { MAX_ROOM_FILE_BYTES } from "./limits.js";
import { capSynced, execText, toolOutput } from "./output.js";
import { QuotaError, roomFile, workspaceRepo, type WorkspaceRepo } from "./repo.js";
import { deleteObjects, getBytes, newObjectKey, putBytes } from "./storage.js";
import { keptNote, overwroteNote, pullPlan, pushPlan, quotaNote } from "./sync.js";
import type { FileAuthor, FilesSynced, FilesUpdated, Manifest, RoomFile } from "./types.js";

type Result = { output: string; ok: boolean; synced: FilesSynced; ms: number };
/**
 * A step whose code has run, saved the moment it returned: what it printed, the time so far, the notes from its pull,
 * and the versions the pull replaced, which are what the run knew of those files.
 */
type Ran = { step: number; ok: boolean; head: string; ms: number; pulledOver: Record<string, number>; notes: string[] };

/**
 * The run's one sandbox session (the `SANDBOX` item): what it last synced with the room, and its latest step, either
 * run (`ran`) or finished (`done`), so a retry of that step never runs its code twice. `offlineHere` is a room that
 * allows internet on a machine that runs every session offline.
 */
export type Session = {
  handle: string; internet: boolean; offlineHere: boolean; startedAt: string; synced: Manifest;
  ran?: Ran; done?: Result & { step: number };
};

export interface SandboxDeps {
  /** A function, so a Lambda that only closes runs loads no sandbox client until a session exists. */
  sandbox: () => Promise<Sandbox>;
  sessions: ReturnType<typeof sessionStore>;
  files: Pick<WorkspaceRepo, "list" | "usage" | "commit" | "remove">;
  storage: { getBytes: typeof getBytes; putBytes: typeof putBytes; deleteObjects: typeof deleteObjects };
  notify: (roomId: string, event: FilesUpdated) => Promise<unknown>;
}

type RunRef = Pick<Run, "runId" | "roomId" | "threadId" | "number" | "deadAt">;
type SandboxCall = { language: Language; code: string; timeoutSec: number };

const BAD_INPUT = "sandbox_run needs language (shell, python or javascript) and code.";
const LOST_TWICE = "The sandbox stopped unexpectedly. Try again.";
const LOST_AFTER = "The sandbox stopped before this step's files were saved; its changes to them are lost.";
const LISTING_FAILED = "Files weren't saved: the sandbox's files couldn't be listed.";
const STOPPED_BEFORE = "Stopped before the code ran.";
const STOPPED_DURING = "Stopped while the code ran; its changes to the room files weren't saved.";
const OFFLINE_HERE = "Internet is off for sandboxes on this machine, though the room allows it.";
const DEFAULT_TIMEOUT_SEC = 60;
const SCRIPT_TIMEOUT_SEC = 60;
/** Room files are read into memory a batch at a time on their way into the sandbox. */
const PULL_BATCH_BYTES = 8 * 1024 * 1024;
// API Gateway drops a WebSocket message over 128 KB.
const FILES_UPDATED_MAX_BYTES = 64 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", svg: "image/svg+xml",
  py: "text/x-python", js: "text/javascript", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf",
};

const noChanges = (): FilesSynced => ({ written: [], deleted: [], notes: [] });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const contentTypeOf = (path: string) => CONTENT_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
const sessionKey = (runId: string) => ({ pk: `RUN#${runId}`, sk: "SANDBOX" });
const unreadNote = (path: string) => `${path} wasn't saved: it couldn't be read.`;

export function sessionStore() {
  const db = docClient();
  const TableName = tableName();
  return {
    async get(runId: string): Promise<Session | undefined> {
      const { Item } = await db.send(new GetCommand({ TableName, Key: sessionKey(runId), ConsistentRead: true }));
      return Item && {
        handle: String(Item.handle), internet: !!Item.internet, offlineHere: !!Item.offlineHere, startedAt: String(Item.startedAt),
        synced: Item.synced as Manifest, ran: Item.ran as Ran | undefined, done: Item.done as Session["done"],
      };
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
    /** The manifest and the step's progress in one write. A session closed meanwhile stays closed. */
    async save(runId: string, synced: Manifest, latest: Pick<Session, "ran"> | Pick<Session, "done">): Promise<void> {
      const [set, drop] = "ran" in latest ? ["ran", "done"] as const : ["done", "ran"] as const;
      try {
        await db.send(new UpdateCommand({
          TableName, Key: sessionKey(runId), UpdateExpression: "SET #synced = :s, #set = :v REMOVE #drop", ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#synced": "synced", "#set": set, "#drop": drop },
          ExpressionAttributeValues: { ":s": synced, ":v": (latest as Record<string, unknown>)[set] },
        }));
      } catch (e) {
        if (!conditionFailed(e)) throw e;
      }
    },
    async remove(runId: string): Promise<void> {
      await db.send(new DeleteCommand({ TableName, Key: sessionKey(runId) }));
    },
    /** The room's internet switch, read when a session starts; a room that never set it stays offline. */
    async internet(roomId: string): Promise<boolean> {
      const { Item } = await db.send(new GetCommand({
        TableName, Key: roomMetaKey(roomId), ConsistentRead: true,
        ProjectionExpression: "#i", ExpressionAttributeNames: { "#i": "sandboxInternet" },
      }));
      return Item?.sandboxInternet === true;
    },
  };
}

const defaultDeps = (): SandboxDeps => ({
  sandbox, sessions: sessionStore(), files: workspaceRepo(), storage: { getBytes, putBytes, deleteObjects }, notify: broadcastToRoom,
});

function parseCall(input: unknown): SandboxCall | null {
  const i = (typeof input === "object" && input ? input : {}) as Record<string, unknown>;
  const timeoutSec = i.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const ok = LANGUAGES.includes(i.language as Language) && typeof i.code === "string"
    && Number.isInteger(timeoutSec) && (timeoutSec as number) >= 1 && (timeoutSec as number) <= MAX_TIMEOUT_SEC;
  return ok ? { language: i.language as Language, code: i.code as string, timeoutSec: timeoutSec as number } : null;
}

/**
 * The run's session, opened on its first use. The conditional put is what keeps a run to one session: an attempt that
 * loses it stops the session it just started and uses the stored one. A session ends by itself once its run is surely
 * over, so one whose close never comes (a run closed as dead from another function) doesn't outlive it.
 */
async function openSession(run: RunRef, box: Sandbox, deps: SandboxDeps): Promise<Session> {
  const stored = await deps.sessions.get(run.runId);
  if (stored) return stored;
  const wanted = await deps.sessions.internet(run.roomId);
  const lifetimeSec = Math.max(60, Math.floor((Date.parse(run.deadAt) - Date.now()) / 1000));
  const { handle, internet } = await box.start({ runId: run.runId, internet: wanted, lifetimeSec });
  const opened: Session = { handle, internet, offlineHere: wanted && !internet, startedAt: new Date().toISOString(), synced: {} };
  if (await deps.sessions.create(run.runId, opened)) return opened;
  await box.stop(handle);
  return (await deps.sessions.get(run.runId))!;
}

/** A session that is gone, or may be: stopped in case it still runs, then forgotten, so the next step opens a new one. */
async function forget(runId: string, handle: string, box: Sandbox, deps: SandboxDeps) {
  await bestEffort("stopping a lost sandbox", () => box.stop(handle));
  await deps.sessions.remove(runId);
}

/** Writes files in one call, or on a failure one at a time, so a file that can't land (a folder in its way) is only that file. */
async function copyIn(box: Sandbox, handle: string, files: WorkspaceFile[]): Promise<Set<string>> {
  try {
    await box.writeFiles(handle, files);
    return new Set();
  } catch (e) {
    if (e instanceof SandboxGone) throw e;
    if (files.length === 1) {
      console.error("copying a room file into the sandbox failed", e);
      return new Set([files[0]!.path]);
    }
  }
  const failed = new Set<string>();
  for (const f of files) for (const path of await copyIn(box, handle, [f])) failed.add(path);
  return failed;
}

/**
 * Brings the sandbox up to the room's files: removes what the room dropped, then writes what changed since the session
 * last synced. A file that couldn't be written keeps the version the sandbox already had, so it isn't saved back over
 * the room's, and is tried again next step.
 */
async function pull(roomId: string, session: Session, box: Sandbox, deps: SandboxDeps): Promise<{ manifest: Manifest; notes: string[] }> {
  const index = await deps.files.list(roomId);
  const plan = pullPlan(index, session.synced);
  const manifest: Manifest = Object.fromEntries(
    index.filter((f) => session.synced[f.path]?.v === f.v).map((f) => [f.path, session.synced[f.path]!]),
  );
  if (plan.remove.length) await box.exec(session.handle, { language: "shell", code: removeCode(plan.remove), timeoutSec: SCRIPT_TIMEOUT_SEC });
  for (const batch of bySize(plan.write, (f) => f.size, PULL_BATCH_BYTES)) {
    const files = await Promise.all(batch.map(async (f) => ({ path: f.path, bytes: await deps.storage.getBytes(f.objectKey) })));
    const failed = await copyIn(box, session.handle, files);
    files.forEach((f, i) => {
      if (!failed.has(f.path)) manifest[f.path] = { v: batch[i]!.v, sha256: sha256(f.bytes) };
      else if (session.synced[f.path]) manifest[f.path] = session.synced[f.path]!;
    });
    plan.notes.push(...[...failed].map((path) => `${path} wasn't copied into the sandbox.`));
  }
  return { manifest, notes: plan.notes };
}

async function listing(box: Sandbox, handle: string): Promise<Listing | undefined> {
  try {
    return parseListing((await box.exec(handle, { language: "shell", code: LIST_CODE, timeoutSec: SCRIPT_TIMEOUT_SEC })).stdout);
  } catch (e) {
    if (e instanceof SandboxGone) throw e;
    console.error("sandbox listing failed", e);
    return undefined;
  }
}

/**
 * Saves to the room what the code changed, deletes first. Each file is a new object, committed over the version the
 * room has now: the last write wins, with a note when that overwrote a version the run didn't know. A delete applies
 * only to the known version, so a newer one someone else wrote is kept. Anything about the files themselves that
 * stops a save is a note, never an error, since the code has already run.
 */
async function push(run: RunRef, handle: string, loaded: Manifest, known: (path: string) => number | undefined, box: Sandbox, deps: SandboxDeps) {
  const listed = await listing(box, handle);
  if (!listed) return { synced: { ...noChanges(), notes: [LISTING_FAILED] }, updated: [], manifest: loaded };
  const [index, usage] = await Promise.all([deps.files.list(run.roomId), deps.files.usage(run.roomId)]);
  const plan = pushPlan(listed, loaded, known, new Map(index.map((f) => [f.path, f])), usage);
  const manifest = { ...loaded };
  const synced: FilesSynced = { written: [], deleted: [], notes: plan.notes };
  const updated: RoomFile[] = [];
  const by: FileAuthor = { kind: "thread", threadId: run.threadId, number: run.number };

  for (const { path, v } of plan.remove) {
    let outcome;
    try {
      outcome = await deps.files.remove(run.roomId, path, v);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      synced.notes.push(`${path} kept changing in the room files while this run deleted it, so the delete was skipped.`);
      continue;
    }
    // Either way the sandbox no longer holds the room's version, so the next pull brings back a kept file.
    delete manifest[path];
    if (outcome.kept) synced.notes.push(keptNote(path, outcome.kept.updatedBy));
    if (outcome.removed) {
      await bestEffort("deleting a removed object", () => deps.storage.deleteObjects([outcome.removed!.objectKey]));
      synced.deleted.push(path);
    }
  }

  for (const { path } of plan.put) {
    let file;
    try {
      [file] = await box.readFiles(handle, [path]);
    } catch (e) {
      if (e instanceof SandboxGone) throw e;
      synced.notes.push(unreadNote(path));
      continue;
    }
    if (!file) continue;
    if (file.bytes.length > MAX_ROOM_FILE_BYTES) {
      synced.notes.push(`${path} wasn't saved: room files are 25 MB at most.`);
      continue;
    }
    const objectKey = newObjectKey(run.roomId);
    const contentType = contentTypeOf(path);
    await deps.storage.putBytes(objectKey, file.bytes, contentType);
    let committed;
    try {
      committed = await deps.files.commit(run.roomId, { path, objectKey, size: file.bytes.length, contentType, by });
    } catch (e) {
      await bestEffort("dropping a refused object", () => deps.storage.deleteObjects([objectKey]));
      if (e instanceof QuotaError) synced.notes.push(quotaNote(path, e.message));
      else if (e instanceof Conflict) synced.notes.push(`${path} kept changing in the room files while this run saved it, so this run's version wasn't saved.`);
      else throw e;
      continue;
    }
    const { file: stored, replaced } = committed;
    if (replaced) {
      await bestEffort("deleting a replaced object", () => deps.storage.deleteObjects([replaced.objectKey]));
      if (replaced.v !== known(path)) synced.notes.push(overwroteNote(path, replaced.updatedBy));
    } else if (known(path) !== undefined) {
      synced.notes.push(`${path} was deleted from the room files after this run loaded it; this run's version brought it back.`);
    }
    manifest[path] = { v: stored.v, sha256: sha256(file.bytes) };
    synced.written.push(path);
    updated.push(roomFile(stored));
  }
  return { synced, updated, manifest };
}

function filesUpdated(roomId: string, files: RoomFile[], deleted: string[]): FilesUpdated {
  const event: FilesUpdated = { type: "files.updated", roomId, files, deleted };
  return Buffer.byteLength(JSON.stringify(event)) > FILES_UPDATED_MAX_BYTES ? { type: "files.updated", roomId, refetch: true } : event;
}

/**
 * The code, between a pull and a push. A Stop asked for while the code runs stops the whole session, which is the one
 * kill every sandbox offers; the run is ending, so its changes aren't saved. Undefined when that happened.
 */
async function execute(session: Session, call: SandboxCall, box: Sandbox, signal?: AbortSignal): Promise<ExecResult | undefined> {
  let killed = false;
  const kill = () => {
    killed = true;
    void bestEffort("stopping the sandbox on a stop", () => box.stop(session.handle));
  };
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const result = await box.exec(session.handle, call);
    return killed ? undefined : result;
  } catch (e) {
    if (killed) return undefined;
    throw e;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

async function runInSession(
  run: RunRef, step: number, call: SandboxCall, session: Session, box: Sandbox, deps: SandboxDeps, t0: number, signal?: AbortSignal,
): Promise<Result> {
  if (session.done?.step === step) {
    const { step: _, ...done } = session.done;
    return done;
  }
  let ran = session.ran?.step === step ? session.ran : undefined;
  let loaded = session.synced;
  if (!ran) {
    if (signal?.aborted) return { ok: false, output: STOPPED_BEFORE, synced: noChanges(), ms: Date.now() - t0 };
    const pulled = await pull(run.roomId, session, box, deps);
    const started = Date.now();
    const result = await execute(session, call, box, signal);
    if (!result) return { ok: false, output: STOPPED_DURING, synced: noChanges(), ms: Date.now() - t0 };
    const head = execText(result, Date.now() - started) + (session.offlineHere ? `\n${OFFLINE_HERE}` : "");
    // What the run knew of a file is the version its session held before this pull: the model wrote this step's code
    // without seeing a change pulled in just now.
    const pulledOver = Object.fromEntries(
      Object.entries(session.synced).filter(([path, s]) => pulled.manifest[path]?.v !== s.v).map(([path, s]) => [path, s.v]),
    );
    ran = { step, ok: result.exitCode === 0 && !result.timedOut, head, ms: Date.now() - t0, pulledOver, notes: pulled.notes };
    loaded = pulled.manifest;
    await deps.sessions.save(run.runId, loaded, { ran });
  }
  const pushing = Date.now();
  const { pulledOver } = ran;
  const known = (path: string) => (Object.hasOwn(pulledOver, path) ? pulledOver[path] : loaded[path]?.v);
  let pushed;
  try {
    pushed = await push(run, session.handle, loaded, known, box, deps);
  } catch (e) {
    if (!(e instanceof SandboxGone)) throw e;
    await forget(run.runId, session.handle, box, deps);
    const synced = capSynced({ ...noChanges(), notes: [...ran.notes, LOST_AFTER] });
    return { ok: ran.ok, output: toolOutput(ran.head, synced), synced, ms: ran.ms + Date.now() - pushing };
  }
  const synced = capSynced({ ...pushed.synced, notes: [...ran.notes, ...pushed.synced.notes] });
  const done = { ok: ran.ok, output: toolOutput(ran.head, synced), synced, ms: ran.ms + Date.now() - pushing };
  await deps.sessions.save(run.runId, pushed.manifest, { done: { step, ...done } });
  if (pushed.updated.length || pushed.synced.deleted.length) {
    await bestEffort("files.updated broadcast", () => deps.notify(run.roomId, filesUpdated(run.roomId, pushed.updated, pushed.synced.deleted)));
  }
  return done;
}

/**
 * One `sandbox_run` call, the run's step number `step`: the room's files into the run's session, the code, then the
 * changes back to the room. A session that vanished before the code finished (a crashed or reaped container, an
 * expired AgentCore session) is replaced once, with a full pull, and the code runs again in it. `ms` is the step's
 * sandbox time, an earlier attempt's included.
 */
export async function runSandbox(
  run: RunRef, step: number, input: unknown, { signal, deps = defaultDeps() }: { signal?: AbortSignal; deps?: SandboxDeps } = {},
): Promise<Result> {
  const call = parseCall(input);
  if (!call) return { ok: false, output: BAD_INPUT, synced: noChanges(), ms: 0 };
  const box = await deps.sandbox();
  const t0 = Date.now();
  for (let attempt = 1; ; attempt++) {
    const session = await openSession(run, box, deps);
    try {
      return await runInSession(run, step, call, session, box, deps, t0, signal);
    } catch (e) {
      if (!(e instanceof SandboxGone)) throw e;
      await forget(run.runId, session.handle, box, deps);
      if (attempt === 2) return { ok: false, output: LOST_TWICE, synced: noChanges(), ms: Date.now() - t0 };
    }
  }
}

/** Ends the run's session, if it has one. A session that can't be stopped is logged; it still ends at its own timeout. */
export async function closeSandbox(runId: string, deps: Pick<SandboxDeps, "sandbox" | "sessions"> = defaultDeps()): Promise<void> {
  const session = await deps.sessions.get(runId);
  if (!session) return;
  await bestEffort("stopping the sandbox", async () => (await deps.sandbox()).stop(session.handle));
  await deps.sessions.remove(runId);
}
