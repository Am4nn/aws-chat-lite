import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Conflict } from "../lib/errors.js";
import { DEAD_AFTER_MS } from "../runs/model.js";
import { SandboxGone, type Sandbox } from "../sandbox/sandbox.js";
import { LIST_CODE, type Listing } from "../sandbox/scripts.js";
import { MAX_ROOM_FILES, OVER_QUOTA, TOO_MANY } from "./limits.js";
import { pathClash } from "./paths.js";
import { QuotaError } from "./repo.js";
import { closeSandbox, runSandbox, type SandboxDeps, type Session } from "./session.js";
import type { FileAuthor, StoredFile } from "./types.js";

const STARTED = new Date().toISOString();
const RUN = { runId: "run-1", roomId: "r", threadId: "t-7", number: 7, startedAt: STARTED };
const THREAD: FileAuthor = { kind: "thread", threadId: "t-7", number: 7 };
const BEA: FileAuthor = { kind: "member", userId: "u-bea", name: "bea" };
const text = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const shell = (code = "work") => ({ language: "shell", code });
const none = { written: [], deleted: [], notes: [] };

type Files = Map<string, Uint8Array>;

/**
 * A sandbox whose sessions are maps of files, with a filesystem's one rule that matters here: a file can't sit where
 * a folder is. The test's `onExec` stands in for the code a step runs.
 */
function memorySandbox() {
  const sessions = new Map<string, Files>();
  const log = { starts: [] as { internet: boolean; lifetimeSec: number }[], stops: [] as string[], execs: 0, written: [] as string[] };
  const state = {
    onExec: async (_files: Files) => {}, goneOnExec: 0, allowInternet: true,
    listing: (l: Listing): Listing | string => l,
  };
  const session = (handle: string) => {
    const files = sessions.get(handle);
    if (!files) throw new SandboxGone(handle);
    return files;
  };
  const sandbox: Sandbox = {
    async start(o) {
      log.starts.push({ internet: o.internet, lifetimeSec: o.lifetimeSec });
      const handle = `h${log.starts.length}`;
      sessions.set(handle, new Map());
      return { handle, internet: o.internet && state.allowInternet };
    },
    async exec(handle, { code }) {
      const files = session(handle);
      if (code === LIST_CODE) {
        const listing = state.listing({
          files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes) })), unreadable: [], badNames: [], more: 0,
        });
        return { stdout: typeof listing === "string" ? listing : JSON.stringify(listing), stderr: "", exitCode: 0, timedOut: false };
      }
      const removing = code.match(/^printf %s (\S+) \| base64 -d \| while/);
      if (removing) {
        for (const path of Buffer.from(removing[1]!, "base64").toString().split("\n")) files.delete(path);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }
      log.execs++;
      if (state.goneOnExec > 0) {
        state.goneOnExec--;
        sessions.delete(handle);
        throw new SandboxGone(handle);
      }
      await state.onExec(files);
      return { stdout: "ran\n", stderr: "", exitCode: 0, timedOut: false };
    },
    async writeFiles(handle, files) {
      for (const f of files) {
        const clash = pathClash([...session(handle).keys()], f.path);
        if (clash) throw new Error(`${f.path}: File exists`);
        session(handle).set(f.path, f.bytes);
        log.written.push(f.path);
      }
    },
    async readFiles(handle, paths) {
      return paths.map((path) => ({ path, bytes: session(handle).get(path)! }));
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
  const memberDelete = (path: string) => index.delete(path);
  return { index, objects, removeCalls, limit, upload, memberDelete, files, storage, bodyOf };
}

function memorySessions(onCreate?: (items: Map<string, Session>) => void) {
  const items = new Map<string, Session>();
  const room = { internet: false };
  const sessions: SandboxDeps["sessions"] = {
    get: async (runId) => items.get(runId),
    async create(runId, s) {
      onCreate?.(items);
      if (items.has(runId)) return false;
      items.set(runId, s);
      return true;
    },
    async save(runId, synced, latest) {
      const { ran: _r, done: _d, ...rest } = items.get(runId)!;
      items.set(runId, { ...rest, synced, ...latest });
    },
    remove: async (runId) => void items.delete(runId),
    internet: async () => room.internet,
  };
  return { items, sessions, room };
}

async function setup(opts: { onCreate?: (items: Map<string, Session>) => void } = {}) {
  const box = memorySandbox();
  const room = memoryRoom();
  const store = memorySessions(opts.onCreate);
  const notified: unknown[] = [];
  const deps: SandboxDeps = {
    sandbox: async () => box.sandbox, sessions: store.sessions, files: room.files, storage: room.storage,
    notify: async (_roomId, event) => void notified.push(event),
  };
  await room.upload("a.txt", "alpha");
  await room.upload("c.txt", "gamma");
  let step = 0;
  /** The next step; `at` repeats one, as a durable retry does. */
  const run = (input: unknown = shell(), o: { at?: number; signal?: AbortSignal } = {}) =>
    runSandbox(RUN, o.at ?? ++step, input, { signal: o.signal, deps });
  return { box, room, store, deps, notified, run };
}

describe("runSandbox", () => {
  it("opens one session on the first call and pulls every file; later calls pull only what changed", async () => {
    const { box, room, run } = await setup();
    const first = await run();
    expect(first).toMatchObject({ ok: true, synced: none });
    expect(first.output).toContain("ran");
    expect(box.log.starts).toHaveLength(1);
    expect(box.log.written.sort()).toEqual(["a.txt", "c.txt"]);

    await room.upload("c.txt", "gamma 2");
    box.log.written = [];
    await run();
    expect(box.log.starts).toHaveLength(1);
    expect(box.log.written).toEqual(["c.txt"]);
    expect(new TextDecoder().decode(box.sessions.get("h1")!.get("c.txt"))).toBe("gamma 2");
  });

  it("gives the session a lifetime that ends when the run is surely over", async () => {
    const { box, run } = await setup();
    await run();
    expect(box.log.starts[0]!.lifetimeSec).toBeGreaterThan(DEAD_AFTER_MS / 1000 - 10);
    expect(box.log.starts[0]!.lifetimeSec).toBeLessThanOrEqual(DEAD_AFTER_MS / 1000);
  });

  it("saves a new file to the room as the thread's, and tells the room", async () => {
    const { box, room, notified, run } = await setup();
    box.state.onExec = async (files) => void files.set("b.txt", text("beta"));
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
    box.state.onExec = async (files) => void files.delete("a.txt");
    const result = await run();
    expect(room.removeCalls).toEqual([["a.txt", 1]]);
    expect(result.synced.deleted).toEqual(["a.txt"]);
    expect(room.index.has("a.txt")).toBe(false);
    expect(room.objects.has(objectKey)).toBe(false);
  });

  it("replaces a file a member changed meanwhile, with a note naming them, and drops the replaced object", async () => {
    const { box, room, run } = await setup();
    let bumped = "";
    box.state.onExec = async (files) => {
      bumped = (await room.upload("c.txt", "bea's")).file.objectKey;
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

  it("says so when it saves a file a member deleted meanwhile", async () => {
    const { box, room, run } = await setup();
    box.state.onExec = async (files) => {
      room.memberDelete("c.txt");
      files.set("c.txt", text("run's"));
    };
    expect((await run()).synced.notes).toEqual(["c.txt was deleted from the room files after this run loaded it; this run's version brought it back."]);
  });

  it("treats a change pulled in at the start of a step as news to the run: replacing it gets the note", async () => {
    const { box, room, run } = await setup();
    box.state.onExec = async (files) => void files.set("a.txt", text("edited"));
    expect((await run()).synced.notes).toEqual([]);

    await room.upload("c.txt", "bea's");
    box.state.onExec = async (files) => void files.set("c.txt", text("run's"));
    expect((await run()).synced.notes).toEqual(["c.txt was changed by @bea after this run loaded it; this run's version replaced it."]);
  });

  it("skips deleting a version pulled in at the start of a step", async () => {
    const { box, room, run } = await setup();
    await run();
    await room.upload("c.txt", "bea's");
    box.state.onExec = async (files) => void files.delete("c.txt");
    expect((await run()).synced.notes).toEqual(["c.txt was changed by @bea after this run loaded it, so this run's delete was skipped."]);
    expect(room.removeCalls).toEqual([["c.txt", 1]]);
  });

  it("skips deleting a file a member changed meanwhile, with a note, and keeps it", async () => {
    const { box, room, run } = await setup();
    box.state.onExec = async (files) => {
      await room.upload("c.txt", "bea's");
      files.delete("c.txt");
    };
    const result = await run();
    expect(room.removeCalls).toEqual([["c.txt", 1]]);
    expect(result.synced).toMatchObject({
      deleted: [], notes: ["c.txt was changed by @bea after this run loaded it, so this run's delete was skipped."],
    });
    expect(room.bodyOf("c.txt")).toBe("bea's");

    // The next step loads the member's version back into the sandbox.
    box.state.onExec = async () => {};
    box.log.written = [];
    await run();
    expect(box.log.written).toEqual(["c.txt"]);
  });

  it("notes a write the room's limits refused at commit time, and drops the object it stored", async () => {
    const { box, room, deps, run } = await setup();
    const before = room.objects.size;
    room.limit.count = 2;
    box.state.onExec = async (files) => void files.set("b.txt", text("beta"));
    expect((await run()).synced).toEqual({ written: [], deleted: [], notes: ["b.txt wasn't saved: a room keeps 1,000 files at most."] });
    expect(room.objects.size).toBe(before);

    deps.files = { ...deps.files, commit: async () => { throw new QuotaError(OVER_QUOTA); } };
    box.state.onExec = async (files) => void files.set("d.txt", text("delta"));
    expect((await run()).synced.notes).toEqual([
      "b.txt wasn't saved: the room's files would pass 100 MB.", "d.txt wasn't saved: the room's files would pass 100 MB.",
    ]);
    expect(room.objects.size).toBe(before);
  });

  it("opens a new session once when the sandbox is lost, stops the old one, pulls everything and runs the code again", async () => {
    const { box, store, run } = await setup();
    box.state.goneOnExec = 1;
    const result = await run();
    expect(result.ok).toBe(true);
    expect(box.log.starts).toHaveLength(2);
    expect(box.log.stops).toEqual(["h1"]);
    expect(box.log.execs).toBe(2);
    expect(box.log.written.sort()).toEqual(["a.txt", "a.txt", "c.txt", "c.txt"]);
    expect(store.items.get(RUN.runId)?.handle).toBe("h2");
  });

  it("gives up when the sandbox is lost twice, leaving no session behind", async () => {
    const { box, store, run } = await setup();
    box.state.goneOnExec = 2;
    expect(await run()).toMatchObject({ ok: false, output: "The sandbox stopped unexpectedly. Try again.", synced: none });
    expect(store.items.has(RUN.runId)).toBe(false);
  });

  it("uses the stored session when another attempt stored one first, and stops its own", async () => {
    let theirs = "";
    const { box, run } = await setup({
      onCreate: (items) => { items.set(RUN.runId, { handle: theirs, internet: false, offlineHere: false, startedAt: "then", synced: {} }); },
    });
    theirs = (await box.sandbox.start({ runId: RUN.runId, internet: false, lifetimeSec: 60 })).handle;
    await run();
    expect(box.log.stops).toEqual(["h2"]);
    expect(box.sessions.get(theirs)!.has("a.txt")).toBe(true);
  });

  it("refuses bad input without opening a session", async () => {
    const { box, run } = await setup();
    const bad = { ok: false, output: "sandbox_run needs language (shell, python or javascript) and code.", synced: none };
    for (const input of [{}, { language: "ruby", code: "x" }, { language: "shell" }, { ...shell(), timeoutSec: 301 }, { ...shell(), timeoutSec: 1.5 }]) {
      expect(await run(input)).toMatchObject(bad);
    }
    expect(box.log.starts).toEqual([]);
  });

  it("reports a failing exit as not ok", async () => {
    const { box, run } = await setup();
    const exec = box.sandbox.exec;
    box.sandbox.exec = async (handle, o) => (o.code === shell().code ? { stdout: "", stderr: "boom", exitCode: 2, timedOut: false } : exec(handle, o));
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^exit 2/);
  });

  it("says when the room allows internet but this machine runs sandboxes offline", async () => {
    const { box, store, run } = await setup();
    store.room.internet = true;
    box.state.allowInternet = false;
    expect((await run()).output).toContain("Internet is off for sandboxes on this machine, though the room allows it.");
    expect((await run()).output).toContain("Internet is off");
  });

  describe("ordinary content never throws a step", () => {
    it("keeps the code's output and saves nothing when the listing fails; the next step saves what changed", async () => {
      const { box, room, run } = await setup();
      box.state.listing = () => "hijacked";
      box.state.onExec = async (files) => {
        files.delete("a.txt");
        files.set("n.txt", text("new"));
      };
      const failed = await run();
      expect(failed).toMatchObject({ ok: true, synced: { ...none, notes: ["Files weren't saved: the sandbox's files couldn't be listed."] } });
      expect(failed.output).toContain("--- stdout\nran");
      expect(room.index.has("a.txt")).toBe(true);

      box.state.listing = (l) => l;
      box.state.onExec = async () => {};
      expect((await run()).synced).toMatchObject({ written: ["n.txt"], deleted: ["a.txt"] });
    });

    it("keeps a file the code made unreadable, with a note", async () => {
      const { box, room, run } = await setup();
      box.state.listing = (l) => ({ ...l, files: l.files.filter((f) => f.path !== "a.txt"), unreadable: ["a.txt"] });
      expect((await run()).synced).toEqual({ ...none, notes: ["a.txt wasn't saved: it couldn't be read."] });
      expect(room.index.has("a.txt")).toBe(true);
    });

    it("notes a file that can't be read back, that grew past 25 MB, or that keeps changing in the room", async () => {
      const { box, deps, run } = await setup();
      box.state.onExec = async (files) => {
        for (const p of ["gone.txt", "huge.bin", "busy.txt"]) files.set(p, text("x"));
      };
      const read = box.sandbox.readFiles;
      box.sandbox.readFiles = async (handle, [path]) => {
        if (path === "gone.txt") throw new Error("head: cannot open 'gone.txt'");
        if (path === "huge.bin") return [{ path, bytes: new Uint8Array(26_214_401) }];
        return read(handle, [path!]);
      };
      const commit = deps.files.commit;
      deps.files = { ...deps.files, commit: async (roomId, c) => { if (c.path === "busy.txt") throw new Conflict("busy"); return commit(roomId, c); } };
      expect((await run()).synced.notes).toEqual([
        "busy.txt kept changing in the room files while this run saved it, so this run's version wasn't saved.",
        "gone.txt wasn't saved: it couldn't be read.",
        "huge.bin wasn't saved: room files are 25 MB at most.",
      ]);
    });

    it("doesn't run the code again when the sandbox is lost after it ran, and starts afresh next step", async () => {
      const { box, store, run } = await setup();
      const exec = box.sandbox.exec;
      box.sandbox.exec = async (handle, o) => {
        if (o.code === LIST_CODE) throw new SandboxGone(handle);
        return exec(handle, o);
      };
      const result = await run();
      expect(box.log.execs).toBe(1);
      expect(result).toMatchObject({ ok: true, synced: { ...none, notes: ["The sandbox stopped before this step's files were saved; its changes to them are lost."] } });
      expect(store.items.has(RUN.runId)).toBe(false);
    });
  });

  describe("sync never loses a file", () => {
    it("renames a file in a full room: the delete goes first", async () => {
      const { box, room, run } = await setup();
      room.limit.count = 2;
      box.state.onExec = async (files) => {
        files.set("b.txt", files.get("a.txt")!);
        files.delete("a.txt");
      };
      expect((await run()).synced).toEqual({ written: ["b.txt"], deleted: ["a.txt"], notes: [] });
      expect(room.bodyOf("b.txt")).toBe("alpha");
    });

    it("lets a room file take the place of a folder the room dropped", async () => {
      const { box, room, run } = await setup();
      await room.upload("out/x", "x");
      await run();
      room.memberDelete("out/x");
      await room.upload("out", "now a file");
      await run();
      expect(new TextDecoder().decode(box.sessions.get("h1")!.get("out"))).toBe("now a file");
    });

    it("notes a room file that can't be copied in, copies the rest, and tries again next step", async () => {
      const { box, room, run } = await setup();
      box.state.onExec = async (files) => void files.set("big/a:b", text("unsaved"));
      await run();
      await room.upload("big", "a file where the sandbox has a folder");
      await room.upload("d.txt", "delta");
      box.state.onExec = async () => {};
      const result = await run();
      expect(result.synced.notes).toContain("big wasn't copied into the sandbox.");
      expect(box.sessions.get("h1")!.has("d.txt")).toBe(true);
      expect((await run()).synced.notes).toContain("big wasn't copied into the sandbox.");
    });

    it("refuses a file that clashes with a room file someone saved meanwhile", async () => {
      const { box, room, run } = await setup();
      box.state.onExec = async (files) => {
        await room.upload("out", "bea's file");
        files.set("out/x", text("run's"));
      };
      expect((await run()).synced.notes)
        .toEqual(["out/x wasn't saved: it clashes with out in the room files, and a file and a folder can't share a name."]);
      expect(room.bodyOf("out")).toBe("bea's file");
    });
  });

  describe("a retried step never runs its code twice", () => {
    it("saves what the code changed from the stored result when the step failed after the code ran", async () => {
      const { box, room, deps, run } = await setup();
      box.state.onExec = async (files) => void files.set("log.txt", text("once"));
      const usage = deps.files.usage;
      deps.files = { ...deps.files, usage: async () => { throw new Error("DynamoDB is having a moment"); } };
      await expect(run()).rejects.toThrow("DynamoDB");
      deps.files = { ...deps.files, usage };

      const retried = await run(shell(), { at: 1 });
      expect(box.log.execs).toBe(1);
      expect(retried).toMatchObject({ ok: true, synced: { written: ["log.txt"] } });
      expect(retried.output).toMatch(/^exit 0 · \d+ ms\n--- stdout\nran\nSaved to room files: log.txt$/);
      expect(room.bodyOf("log.txt")).toBe("once");
    });

    it("returns the stored result of a step that finished, without syncing again", async () => {
      const { box, notified, run } = await setup();
      box.state.onExec = async (files) => void files.set("b.txt", text("beta"));
      const first = await run();
      expect(await run(shell(), { at: 1 })).toEqual(first);
      expect(box.log.execs).toBe(1);
      expect(notified).toHaveLength(1);

      await run();
      expect(box.log.execs).toBe(2);
    });
  });

  describe("Stop", () => {
    it("kills a running exec by stopping the session, and saves nothing", async () => {
      const { box, room, run } = await setup();
      const stop = new AbortController();
      box.state.onExec = async (files) => {
        files.set("half.txt", text("half"));
        stop.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      const exec = box.sandbox.exec;
      box.sandbox.exec = async (handle, o) => {
        const result = await exec(handle, o);
        if (!box.sessions.has(handle)) throw new Error("the exec's connection dropped");
        return result;
      };
      expect(await run(shell(), { signal: stop.signal })).toMatchObject({
        ok: false, output: "Stopped while the code ran; its changes to the room files weren't saved.", synced: none,
      });
      expect(box.log.stops).toEqual(["h1"]);
      expect(room.index.has("half.txt")).toBe(false);
    });

    it("doesn't run the code once a stop has been asked for", async () => {
      const { box, run } = await setup();
      expect(await run(shell(), { signal: AbortSignal.abort() })).toMatchObject({ ok: false, output: "Stopped before the code ran." });
      expect(box.log.execs).toBe(0);
    });
  });

  describe("bounded output", () => {
    it("caps the lists and notes, and asks members to refetch instead of sending thousands of files", async () => {
      const { box, room, notified, run } = await setup();
      box.state.onExec = async (files) => {
        for (let i = 0; i < 3000; i++) files.set(`f/${String(i).padStart(4, "0")}`, text("x"));
      };
      const result = await run();
      expect(result.synced.written).toHaveLength(51);
      expect(result.synced.written.at(-1)).toBe("…and 948 more");
      expect(result.synced.notes).toHaveLength(21);
      expect(result.synced.notes.at(-1)).toBe("…and 1982 more notes.");
      expect(result.output.length).toBeLessThan(10_000);
      expect(notified).toEqual([{ type: "files.updated", roomId: "r", refetch: true }]);
    });
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
