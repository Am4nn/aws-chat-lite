import { describe, expect, it } from "vitest";
import { authorWho, keptNote, overwroteNote, pullPlan, pushPlan } from "./sync.js";
import type { FileAuthor, RoomFile } from "./types.js";

const by: FileAuthor = { kind: "member", userId: "u", name: "bea" };
const room = (path: string, v: number, size = 1): RoomFile => ({ path, size, contentType: "text/plain", v, updatedAt: "t", updatedBy: by });
const listed = (path: string, size: number, sha256 = "new") => ({ path, size, sha256 });
const MB = 1024 * 1024;

describe("pullPlan", () => {
  it("writes changed room files and removes ones the room dropped", () => {
    const synced = { a: { v: 1, sha256: "x" }, b: { v: 1, sha256: "y" }, c: { v: 3, sha256: "z" } };
    expect(pullPlan([room("a", 2), room("b", 1)], synced)).toEqual({ write: [room("a", 2)], remove: ["c"] });
  });
  it("writes every file to a fresh session", () => expect(pullPlan([room("a", 1)], {}).write).toEqual([room("a", 1)]));
});

describe("pushPlan", () => {
  const none = { bytes: 0, count: 0 };
  const plan = (listing: ReturnType<typeof listed>[], synced = {}, index: RoomFile[] = [], usage = none) =>
    pushPlan(listing, synced, new Map(index.map((f) => [f.path, f])), usage);

  it("ignores unchanged files", () => expect(plan([listed("a", 1, "x")], { a: { v: 1, sha256: "x" } })).toEqual({ put: [], remove: [], notes: [] }));
  it("puts new and changed files in path order", () => {
    const { put } = plan([listed("z", 1), listed("n.txt", 1), listed("a", 1, "x2")], { a: { v: 1, sha256: "x" } });
    expect(put.map((f) => f.path)).toEqual(["a", "n.txt", "z"]);
  });
  it("removes synced files that are gone", () =>
    expect(plan([], { "old.txt": { v: 4, sha256: "x" } }).remove).toEqual([{ path: "old.txt", v: 4 }]));
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
});

describe("conflict notes", () => {
  it("names a member with @ and a thread with #", () => {
    expect(authorWho(by)).toBe("@bea");
    const thread: FileAuthor = { kind: "thread", threadId: "t", number: 12 };
    expect(overwroteNote("n.txt", thread)).toBe("n.txt was changed by #12 after this run loaded it; this run's version replaced it.");
    expect(keptNote("n.txt", by)).toBe("n.txt was changed by @bea after this run loaded it, so this run's delete was skipped.");
  });
});
