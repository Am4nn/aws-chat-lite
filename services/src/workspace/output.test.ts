import { describe, expect, it } from "vitest";
import { capSynced, execText, toolOutput } from "./output.js";

const ok = { stdout: "", stderr: "", exitCode: 0, timedOut: false };
const none = { written: [], deleted: [], notes: [] };

describe("toolOutput", () => {
  it("leads with the exit code and time, then stdout", () => {
    expect(toolOutput(execText({ ...ok, stdout: "hi\n" }, 812), none)).toBe("exit 0 · 812 ms\n--- stdout\nhi");
  });
  it("marks a timeout and shows stderr", () => {
    expect(toolOutput(execText({ ...ok, stderr: "boom", exitCode: 124, timedOut: true }, 60000), none)).toBe(
      "exit 124 · 60000 ms · timed out\n--- stderr\nboom",
    );
  });
  it("keeps the last 8,000 characters", () => {
    const out = execText({ ...ok, stdout: `${"a".repeat(1000)}${"b".repeat(8000)}` }, 1);
    expect(out).toContain(`--- stdout\n… (1000 earlier characters cut)\n${"b".repeat(8000)}`);
    expect(out).not.toContain("aaa");
  });
  it("lists what changed in the room files, then each note", () => {
    const head = execText(ok, 5);
    expect(toolOutput(head, { written: ["a", "b"], deleted: ["c"], notes: ["n1", "n2"] }))
      .toBe("exit 0 · 5 ms\nSaved to room files: a, b\nDeleted from room files: c\nn1\nn2");
    expect(toolOutput(head, { ...none, written: ["a"] }).endsWith("Saved to room files: a")).toBe(true);
  });
});

describe("capSynced", () => {
  it("keeps 50 paths and 20 notes, and says how many more there were", () => {
    const paths = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const capped = capSynced({ written: paths(5000, "w"), deleted: paths(51, "d"), notes: paths(5000, "n") });
    expect(capped.written).toEqual([...paths(50, "w"), "…and 4950 more"]);
    expect(capped.deleted).toEqual([...paths(50, "d"), "…and 1 more"]);
    expect(capped.notes).toEqual([...paths(20, "n"), "…and 4980 more notes."]);
    expect(capSynced({ written: ["a"], deleted: [], notes: ["n"] })).toEqual({ written: ["a"], deleted: [], notes: ["n"] });
  });
});
