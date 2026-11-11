import { describe, expect, it } from "vitest";
import type { RoomFile, ThreadSummary } from "../types";
import { applyFilesUpdate, authorLabel, runFiles, screenUploads } from "./files";

const MB = 1_048_576;
const file = (path: string, o: Partial<RoomFile> = {}): RoomFile => ({
  path, size: 10, contentType: "text/plain", v: 1, updatedAt: "2026-11-11T10:00:00Z",
  updatedBy: { kind: "member", userId: "u1", name: "aman" }, ...o,
});
const thread = (o: Partial<ThreadSummary>) => ({ threadId: "t1", number: 12, name: "pr-check", ...o }) as ThreadSummary;

describe("applyFilesUpdate", () => {
  it("replaces by path, drops deletes and keeps the list in path order", () => {
    const next = applyFilesUpdate([file("a", { v: 1 }), file("c")], { files: [file("a", { v: 2 }), file("b")], deleted: ["c"] });
    expect(next.map((f) => [f.path, f.v])).toEqual([["a", 2], ["b", 1]]);
  });
  it("keeps the newer version when an older one arrives late (a slow upload answer after the socket's update)", () => {
    expect(applyFilesUpdate([file("a", { v: 3 })], { files: [file("a", { v: 2 })], deleted: [] }).map((f) => f.v)).toEqual([3]);
  });
});

describe("authorLabel", () => {
  it("names a member with @", () => expect(authorLabel({ kind: "member", userId: "u1", name: "aman" }, [])).toBe("@aman"));
  it("names a thread by number and name", () =>
    expect(authorLabel({ kind: "thread", threadId: "t1", number: 12 }, [thread({})])).toBe("#12 pr-check"));
  it("falls back to the number for a thread it doesn't know", () =>
    expect(authorLabel({ kind: "thread", threadId: "gone", number: 12 }, [])).toBe("#12"));
});

describe("screenUploads", () => {
  it("asks before replacing a file the room already has", () => {
    expect(screenUploads([{ name: "a.txt", size: 5 }, { name: "n.txt", size: 5 }], [file("a.txt")], 10))
      .toEqual({ upload: ["n.txt"], replace: ["a.txt"], refused: [] });
  });

  it("takes one of two picked files with the same name", () => {
    expect(screenUploads([{ name: "a.txt", size: 5 }, { name: "a.txt", size: 9 }], [], 0)).toEqual({ upload: ["a.txt"], replace: [], refused: [] });
  });

  it("refuses a file over 25 MB", () => {
    expect(screenUploads([{ name: "big.zip", size: 26 * MB }], [], 0).refused)
      .toEqual([{ name: "big.zip", why: "Room files are 25 MB at most." }]);
  });

  it("refuses what would take the room past 100 MB", () => {
    expect(screenUploads([{ name: "x.bin", size: 200 * 1024 }], [], Math.round(99.9 * MB)).refused)
      .toEqual([{ name: "x.bin", why: "The room's files would pass 100 MB." }]);
  });

  it("counts a replacement by its size difference, and the picked files together", () => {
    const used = 100 * MB - 10;
    expect(screenUploads([{ name: "a.txt", size: 10 }], [file("a.txt", { size: 10 })], used).replace).toEqual(["a.txt"]);
    expect(screenUploads([{ name: "x", size: 6 }, { name: "y", size: 6 }], [], used))
      .toMatchObject({ upload: ["x"], refused: [{ name: "y" }] });
  });

  it("refuses a new file once the room keeps 1,000", () => {
    const full = Array.from({ length: 1000 }, (_, i) => file(`f${i}`, { size: 1 }));
    expect(screenUploads([{ name: "one-more", size: 1 }], full, 1000).refused)
      .toEqual([{ name: "one-more", why: "A room keeps 1,000 files at most." }]);
  });
});

describe("runFiles", () => {
  it("lists what this thread wrote since its run started", () => {
    const by = { kind: "thread", threadId: "t1", number: 12 } as const;
    const files = [
      file("old.csv", { updatedBy: by, updatedAt: "2026-11-11T09:00:00Z" }),
      file("out.csv", { updatedBy: by, updatedAt: "2026-11-11T10:05:00Z" }),
      file("mine.txt", { updatedAt: "2026-11-11T10:06:00Z" }),
    ];
    expect(runFiles(files, thread({ startedAt: "2026-11-11T10:00:00Z" }))).toEqual(["out.csv"]);
  });
});
