import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIST_CODE } from "../sandbox/listing.js";
import { SandboxGone, type Sandbox } from "../sandbox/sandbox.js";
import { MAX_ROOM_FILES, OVER_QUOTA, TOO_MANY } from "./limits.js";
import { QuotaError } from "./repo.js";
import { closeSandbox, runSandbox, type SandboxDeps, type Session } from "./session.js";
import type { FileAuthor, StoredFile } from "./types.js";

const RUN = { runId: "run-1", roomId: "r", threadId: "t-7", number: 7 };
const THREAD: FileAuthor = { kind: "thread", threadId: "t-7", number: 7 };
const BEA: FileAuthor = { kind: "member", userId: "u-bea", name: "bea" };
const text = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const shell = (code = "work") => ({ language: "shell", code });

type Files = Map<string, Uint8Array>;

/** A sandbox whose sessions are maps of files; the test's `onExec` stands in for the code a step runs. */
function memorySandbox() {
  const sessions = new Map<string, Files>();
  const log = { starts: 0, stops: [] as string[], execs: 0, written: [] as string[], removed: [] as string[] };
  const state = { onExec: (_files: Files) => {}, goneOnExec: 0 };
  const session = (handle: string) => {
    const files = sessions.get(handle);
    if (!files) throw new SandboxGone(handle);
    return files;
  };
  const sandbox: Sandbox = {
    async start() {
      const handle = `h${++log.starts}`;
      sessions.set(handle, new Map());
      return handle;
    },
    async exec(handle, { code }) {
      const files = session(handle);
      if (code === LIST_CODE) {
        const listing = [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes) }));
        return { stdout: JSON.stringify(listing), stderr: "", exitCode: 0, timedOut: false };
      }
      log.execs++;
      if (state.goneOnExec > 0) {
        state.goneOnExec--;
        sessions.delete(handle);
        throw new SandboxGone(handle);
      }
      state.onExec(files);
      return { stdout: "ran\n", stderr: "", exitCode: 0, timedOut: false };
    },
    async writeFiles(handle, files) {
      for (const f of files) {
        session(handle).set(f.path, f.bytes);
        log.written.push(f.path);
      }
    },
    async readFiles(handle, paths) {
      return paths.map((path) => ({ path, bytes: session(handle).get(path)! }));
    },
    async removeFiles(handle, paths) {
      for (const p of paths) session(handle).delete(p);
      log.removed.push(...paths);
    },
    async stop(handle) {
      log.stops.push(handle);
      sessions.delete(handle);
    },
  };
  return { sandbox, sessions, log, state };
}

/** The room's index and bucket, with the repo's version checks and limits. */
function memoryRoom() {
  const index = new Map<string, StoredFile>();
  const objects = new Map<string, Uint8Array>();
  const removeCalls: [string, number | undefined][] = [];
  const limit = { count: MAX_ROOM_FILES };
  let keys = 0;
  const commit = async (_roomId: string, c: { path: string; objectKey: string; size: number; contentType: string; by: FileAuthor }) => {
    const prev = index.get(c.path);
    if (!prev && index.size + 1 > limit.count) throw new QuotaError(TOO_MANY);
    const file: StoredFile = {
      path: c.path, size: c.size, contentType: c.contentType, v: (prev?.v ?? 0) + 1, updatedAt: "now", updatedBy: c.by, objectKey: c.objectKey,
    };
    index.set(c.path, file);
    return { file, ...(prev && { replaced: prev }) };
  };
  /** A member's upload, straight into the room. */
  const upload = async (path: string, body: string, by = BEA) => {
    const objectKey = `seed-${++keys}`;
    objects.set(objectKey, text(body));
    return commit("r", { path, objectKey, size: body.length, contentType: "text/plain", by });
  };
  const files: SandboxDeps["files"] = {
    list: async () => [...index.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    usage: async () => ({ bytes: [...index.values()].reduce((n, f) => n + f.size, 0), count: index.size }),
    commit,
    async remove(_roomId, path, expectV) {
      removeCalls.push([path, expectV]);
      const current = index.get(path);
      if (!current) return {};
      if (expectV !== undefined && current.v !== expectV) return { kept: current };
      index.delete(path);
      return { removed: current };
    },
  };
  const storage: SandboxDeps["storage"] = {
    getBytes: async (key) => objects.get(key)!,
    putBytes: async (key, bytes) => void objects.set(key, bytes),
    deleteObjects: async (ks) => { for (const k of ks) objects.delete(k); },
  };
  const bodyOf = (path: string) => new TextDecoder().decode(objects.get(index.get(path)!.objectKey));
  return { index, objects, removeCalls, limit, upload, files, storage, bodyOf };
}

function memorySessions(onCreate?: (items: Map<string, Session>) => void) {
  const items = new Map<string, Session>();
  const sessions: SandboxDeps["sessions"] = {
    get: async (runId) => items.get(runId),
    async create(runId, s) {
      onCreate?.(items);
      if (items.has(runId)) return false;
      items.set(runId, s);
      return true;
    },
    saveSynced: async (runId, synced) => void items.set(runId, { ...items.get(runId)!, synced }),
    remove: async (runId) => void items.delete(runId),
    internet: async () => false,
  };
  return { items, sessions };
}

async function setup(opts: { onCreate?: (items: Map<string, Session>) => void } = {}) {
  const box = memorySandbox();
  const room = memoryRoom();
  const store = memorySessions(opts.onCreate);
  const notified: unknown[] = [];
  const deps: SandboxDeps = {
    sandbox: () => box.sandbox, sessions: store.sessions, files: room.files, storage: room.storage,
    notify: async (_roomId, event) => void notified.push(event),
  };
  await room.upload("a.txt", "alpha");
  await room.upload("c.txt", "gamma");
  const run = (input: unknown = shell()) => runSandbox(RUN, input, deps);
  return { box, room, store, deps, notified, run };
}

describe("runSandbox", () => {
  it("opens one session on the first call and pulls every file; later calls pull only what changed", async () => {
    const { box, room, run } = await setup();
    const first = await run();
    expect(first).toMatchObject({ ok: true, synced: { written: [], deleted: [], notes: [] } });
    expect(first.output).toContain("ran");
    expect(box.log.starts).toBe(1);
    expect(box.log.written.sort()).toEqual(["a.txt", "c.txt"]);

    await room.upload("c.txt", "gamma 2");
    box.log.written = [];
    await run();
    expect(box.log.starts).toBe(1);
    expect(box.log.written).toEqual(["c.txt"]);
    expect(new TextDecoder().decode(box.sessions.get("h1")!.get("c.txt"))).toBe("gamma 2");
  });

  it("saves a new file to the room as the thread's, and tells the room", async () => {
    const { box, room, notified, run } = await setup();
    box.state.onExec = (files) => void files.set("b.txt", text("beta"));
    const result = await run();
    expect(result.synced).toEqual({ written: ["b.txt"], deleted: [], notes: [] });
    expect(result.output).toContain("Saved to room files: b.txt");
    expect(room.index.get("b.txt")).toMatchObject({ v: 1, size: 4, updatedBy: THREAD });
    expect(room.bodyOf("b.txt")).toBe("beta");
    expect(notified).toEqual([{ type: "files.updated", roomId: "r", files: [expect.objectContaining({ path: "b.txt" })], deleted: [] }]);
    expect(notified[0]).not.toHaveProperty("files.0.objectKey");
  });

  it("deletes a file the code deleted, at the version it loaded, and drops its object", async () => {
    const { box, room, run } = await setup();
    const objectKey = room.index.get("a.txt")!.objectKey;
    box.state.onExec = (files) => void files.delete("a.txt");
    const result = await run();
    expect(room.removeCalls).toEqual([["a.txt", 1]]);
    expect(result.synced.deleted).toEqual(["a.txt"]);
    expect(room.index.has("a.txt")).toBe(false);
    expect(room.objects.has(objectKey)).toBe(false);
  });

  it("replaces a file a member changed meanwhile, with a note naming them, and drops the replaced object", async () => {
    const { box, room, run } = await setup();
    let bumped = "";
    box.state.onExec = (files) => {
      void room.upload("c.txt", "bea's").then((c) => { bumped = c.file.objectKey; });
      files.set("c.txt", text("run's"));
    };
    const result = await run();
    const note = "c.txt was changed by @bea after this run loaded it; this run's version replaced it.";
    expect(result.synced.notes).toEqual([note]);
    expect(result.output).toContain(note);
    expect(room.bodyOf("c.txt")).toBe("run's");
    expect(room.index.get("c.txt")).toMatchObject({ v: 3, updatedBy: THREAD });
    expect(room.objects.has(bumped)).toBe(false);
  });

  it("treats a change pulled in at the start of a step as news to the run: replacing it gets the note", async () => {
    const { box, room, run } = await setup();
    box.state.onExec = (files) => void files.set("a.txt", text("edited"));
    expect((await run()).synced.notes).toEqual([]);

    await room.upload("c.txt", "bea's");
    box.state.onExec = (files) => void files.set("c.txt", text("run's"));
    expect((await run()).synced.notes).toEqual(["c.txt was changed by @bea after this run loaded it; this run's version replaced it."]);
  });

  it("skips deleting a version pulled in at the start of a step", async () => {
    const { box, room, run } = await setup();
    await run();
    await room.upload("c.txt", "bea's");
    box.state.onExec = (files) => void files.delete("c.txt");
    expect((await run()).synced.notes).toEqual(["c.txt was changed by @bea after this run loaded it, so this run's delete was skipped."]);
    expect(room.removeCalls).toEqual([["c.txt", 1]]);
  });

  it("skips deleting a file a member changed meanwhile, with a note, and keeps it", async () => {
    const { box, room, run } = await setup();
    box.state.onExec = (files) => {
      void room.upload("c.txt", "bea's");
      files.delete("c.txt");
    };
    const result = await run();
    expect(room.removeCalls).toEqual([["c.txt", 1]]);
    expect(result.synced).toMatchObject({
      deleted: [], notes: ["c.txt was changed by @bea after this run loaded it, so this run's delete was skipped."],
    });
    expect(room.bodyOf("c.txt")).toBe("bea's");

    // The next step loads the member's version back into the sandbox.
    box.state.onExec = () => {};
    box.log.written = [];
    await run();
    expect(box.log.written).toEqual(["c.txt"]);
  });

  it("notes a write the room's limits refused at commit time, and drops the object it stored", async () => {
    const { box, room, deps, run } = await setup();
    const before = room.objects.size;
    room.limit.count = 2;
    box.state.onExec = (files) => void files.set("b.txt", text("beta"));
    expect((await run()).synced).toEqual({ written: [], deleted: [], notes: ["b.txt wasn't saved: a room keeps 1,000 files at most."] });
    expect(room.objects.size).toBe(before);

    deps.files = { ...deps.files, commit: async () => { throw new QuotaError(OVER_QUOTA); } };
    box.state.onExec = (files) => void files.set("d.txt", text("delta"));
    expect((await run()).synced.notes).toEqual([
      "b.txt wasn't saved: the room's files would pass 100 MB.", "d.txt wasn't saved: the room's files would pass 100 MB.",
    ]);
    expect(room.objects.size).toBe(before);
  });

  it("opens a new session once when the sandbox is lost, pulls everything into it and runs the code again", async () => {
    const { box, store, run } = await setup();
    box.state.goneOnExec = 1;
    const result = await run();
    expect(result.ok).toBe(true);
    expect(box.log.starts).toBe(2);
    expect(box.log.execs).toBe(2);
    expect(box.log.written.sort()).toEqual(["a.txt", "a.txt", "c.txt", "c.txt"]);
    expect(store.items.get(RUN.runId)?.handle).toBe("h2");
  });

  it("gives up when the sandbox is lost twice, leaving no session behind", async () => {
    const { box, store, run } = await setup();
    box.state.goneOnExec = 2;
    expect(await run()).toEqual({
      ok: false, output: "The sandbox stopped unexpectedly. Try again.", synced: { written: [], deleted: [], notes: [] },
    });
    expect(store.items.has(RUN.runId)).toBe(false);
  });

  it("uses the stored session when another attempt stored one first, and stops its own", async () => {
    let theirs = "";
    const { box, run } = await setup({
      onCreate: (items) => { items.set(RUN.runId, { handle: theirs, internet: false, startedAt: "then", synced: {} }); },
    });
    theirs = await box.sandbox.start({ runId: RUN.runId, internet: false });
    await run();
    expect(box.log.stops).toEqual(["h2"]);
    expect(box.sessions.get(theirs)!.has("a.txt")).toBe(true);
  });

  it("refuses bad input without opening a session", async () => {
    const { box, run } = await setup();
    const bad = { ok: false, output: "sandbox_run needs language (shell, python or javascript) and code.", synced: { written: [], deleted: [], notes: [] } };
    for (const input of [{}, { language: "ruby", code: "x" }, { language: "shell" }, { ...shell(), timeoutSec: 301 }, { ...shell(), timeoutSec: 1.5 }]) {
      expect(await run(input)).toEqual(bad);
    }
    expect(box.log.starts).toBe(0);
  });

  it("reports a failing exit as not ok", async () => {
    const { box, run } = await setup();
    box.sandbox.exec = async (_handle, o) =>
      o.code === LIST_CODE ? { stdout: "[]", stderr: "", exitCode: 0, timedOut: false } : { stdout: "", stderr: "boom", exitCode: 2, timedOut: false };
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^exit 2/);
  });
});

describe("closeSandbox", () => {
  it("stops the run's session and forgets it; a second close does nothing", async () => {
    const { box, store, deps, run } = await setup();
    await run();
    await closeSandbox(RUN.runId, deps);
    await closeSandbox(RUN.runId, deps);
    expect(box.log.stops).toEqual(["h1"]);
    expect(store.items.has(RUN.runId)).toBe(false);
  });

  it("forgets the session even when stopping it fails", async () => {
    const { box, store, deps, run } = await setup();
    await run();
    box.sandbox.stop = async () => { throw new Error("daemon down"); };
    await closeSandbox(RUN.runId, deps);
    expect(store.items.has(RUN.runId)).toBe(false);
  });
});
