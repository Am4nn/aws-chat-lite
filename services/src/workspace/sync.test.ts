import { describe, expect, it } from "vitest";
import type { Listing } from "../sandbox/scripts.js";
import { authorWho, keptNote, overwroteNote, pullPlan, pushPlan } from "./sync.js";
import type { FileAuthor, Manifest, RoomFile } from "./types.js";

const by: FileAuthor = { kind: "member", userId: "u", name: "bea" };
const room = (path: string, v: number, size = 1): RoomFile => ({ path, size, contentType: "text/plain", v, updatedAt: "t", updatedBy: by });
const listed = (path: string, size: number, sha256 = "new") => ({ path, size, sha256 });
const MB = 1024 * 1024;

describe("pullPlan", () => {
  it("writes changed room files and removes ones the room dropped", () => {
    const synced = { a: { v: 1, sha256: "x" }, b: { v: 1, sha256: "y" }, c: { v: 3, sha256: "z" } };
    expect(pullPlan([room("a", 2), room("b", 1)], synced)).toEqual({ write: [room("a", 2)], remove: ["c"], notes: [] });
  });
  it("writes every file to a fresh session", () => expect(pullPlan([room("a", 1)], {}).write).toEqual([room("a", 1)]));
  it("lets a file take the place of a folder the room no longer has", () => {
    expect(pullPlan([room("out", 1)], { "out/x": { v: 1, sha256: "x" } })).toEqual({ write: [room("out", 1)], remove: ["out/x"], notes: [] });
  });
  it("skips a file that clashes with a folder the sandbox still holds, with a note", () => {
    expect(pullPlan([room("out", 1), room("out/y", 2)], { "out/y": { v: 1, sha256: "y" } })).toEqual({
      write: [room("out/y", 2)], remove: [], notes: ["out wasn't copied into the sandbox: it clashes with out/y there."],
    });
  });
});

describe("pushPlan", () => {
  const none = { bytes: 0, count: 0 };
  const listing = (files: ReturnType<typeof listed>[], o: Partial<Listing> = {}): Listing => ({ files, unreadable: [], badNames: [], more: 0, ...o });
  const plan = (l: Listing | ReturnType<typeof listed>[], loaded: Manifest = {}, index: RoomFile[] = [], usage = none) =>
    pushPlan(Array.isArray(l) ? listing(l) : l, loaded, (path) => loaded[path]?.v, new Map(index.map((f) => [f.path, f])), usage);

  it("ignores unchanged files", () => expect(plan([listed("a", 1, "x")], { a: { v: 1, sha256: "x" } })).toEqual({ put: [], remove: [], notes: [] }));
  it("puts new and changed files in path order", () => {
    const { put } = plan([listed("z", 1), listed("n.txt", 1), listed("a", 1, "x2")], { a: { v: 1, sha256: "x" } });
    expect(put.map((f) => f.path)).toEqual(["a", "n.txt", "z"]);
  });
  it("removes synced files that are gone, at the version the run knew", () => {
    const loaded = { "old.txt": { v: 4, sha256: "x" } };
    expect(pushPlan(listing([]), loaded, () => 3, new Map(), none).remove).toEqual([{ path: "old.txt", v: 3 }]);
  });
  it("refuses a file over 25 MB", () =>
    expect(plan([listed("big.bin", 30 * MB)])).toEqual({
      put: [], remove: [], notes: ["big.bin (30.0 MB) wasn't saved: room files are 25 MB at most."],
    }));
  it("stops saving once the room would pass 100 MB", () => {
    const { put, notes } = plan([listed("x", 6), listed("y", 6)], {}, [], { bytes: 100 * MB - 10, count: 2 });
    expect(put.map((f) => f.path)).toEqual(["x"]);
    expect(notes).toEqual(["y wasn't saved: the room's files would pass 100 MB."]);
  });
  it("counts only the size difference of a replaced file", () =>
    expect(plan([listed("big", 4 * MB)], { big: { v: 1, sha256: "old" } }, [room("big", 1, 5 * MB)], { bytes: 100 * MB, count: 1 }).put).toHaveLength(1));
  it("refuses a new file in a full room but still replaces one", () => {
    const full = { bytes: 0, count: 1000 };
    expect(plan([listed("n", 1)], {}, [], full).notes).toEqual(["n wasn't saved: a room keeps 1,000 files at most."]);
    expect(plan([listed("a", 1)], {}, [room("a", 1)], full).put).toHaveLength(1);
  });
  it("refuses a name a room file can't have", () =>
    expect(plan([listed("a:b", 1)]).notes).toEqual(["a:b wasn't saved: its name can't be used for a room file."]));

  it("counts this step's deletes first, so a rename in a full room keeps the file", () => {
    const full = { bytes: 1000, count: 1000 };
    const renamed = plan([listed("b", 1, "x")], { a: { v: 1, sha256: "x" } }, [room("a", 1)], full);
    expect(renamed).toEqual({ put: [listed("b", 1, "x")], remove: [{ path: "a", v: 1 }], notes: [] });
    const moved = plan([listed("data/big.csv", 20 * MB, "x")], { "big.csv": { v: 1, sha256: "x" } }, [room("big.csv", 1, 20 * MB)], { bytes: 95 * MB, count: 1 });
    expect(moved.put).toHaveLength(1);
  });
  it("doesn't count a delete that will be skipped because someone changed the file", () => {
    const full = { bytes: 1000, count: 1000 };
    expect(plan([listed("b", 1)], { a: { v: 1, sha256: "x" } }, [room("a", 2)], full).notes)
      .toEqual(["b wasn't saved: a room keeps 1,000 files at most."]);
  });

  it("refuses a file that clashes with a room file or folder it doesn't hold, unless this step deletes it", () => {
    expect(plan([listed("out/x", 1)], {}, [room("out", 1)]).notes)
      .toEqual(["out/x wasn't saved: it clashes with out in the room files, and a file and a folder can't share a name."]);
    expect(plan([listed("out", 1)], {}, [room("out/x", 1)]).put).toEqual([]);
    expect(plan([listed("out/x", 1)], { out: { v: 1, sha256: "y" } }, [room("out", 1)]).put).toHaveLength(1);
  });

  it("keeps a file it couldn't read, and anything in a folder it couldn't read, with a note", () => {
    const loaded = { "locked.txt": { v: 1, sha256: "x" }, "box/a": { v: 1, sha256: "y" }, boxed: { v: 1, sha256: "z" } };
    expect(plan(listing([], { unreadable: ["locked.txt", "box"] }), loaded)).toEqual({
      put: [], remove: [{ path: "boxed", v: 1 }],
      notes: ["locked.txt wasn't saved: it couldn't be read.", "box wasn't saved: it couldn't be read."],
    });
  });
  it("notes a name that isn't UTF-8", () =>
    expect(plan(listing([], { badNames: ["x�y"] })).notes).toEqual(["x�y wasn't saved: its name isn't valid UTF-8."]));
  it("saves no deletes from a listing cut short, since a file past the cut looks deleted", () => {
    expect(plan(listing([listed("n", 1)], { more: 7 }), { gone: { v: 1, sha256: "x" } })).toEqual({
      put: [listed("n", 1)], remove: [],
      notes: ["7 more files weren't checked, because the working directory holds too many; this step's deletes weren't saved."],
    });
  });
});

describe("conflict notes", () => {
  it("names a member with @ and a thread with #", () => {
    expect(authorWho(by)).toBe("@bea");
    const thread: FileAuthor = { kind: "thread", threadId: "t", number: 12 };
    expect(overwroteNote("n.txt", thread)).toBe("n.txt was changed by #12 after this run loaded it; this run's version replaced it.");
    expect(keptNote("n.txt", by)).toBe("n.txt was changed by @bea after this run loaded it, so this run's delete was skipped.");
  });
});
