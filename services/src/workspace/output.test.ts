import { describe, expect, it } from "vitest";
import { toolOutput } from "./output.js";

const ok = { stdout: "", stderr: "", exitCode: 0, timedOut: false };
const none = { written: [], deleted: [], notes: [] };

describe("toolOutput", () => {
  it("leads with the exit code and time, then stdout", () => {
    expect(toolOutput({ ...ok, stdout: "hi\n" }, 812, none)).toBe("exit 0 · 812 ms\n--- stdout\nhi");
  });
  it("marks a timeout and shows stderr", () => {
    expect(toolOutput({ ...ok, stderr: "boom", exitCode: 124, timedOut: true }, 60000, none)).toBe(
      "exit 124 · 60000 ms · timed out\n--- stderr\nboom",
    );
  });
  it("keeps the last 8,000 characters", () => {
    const out = toolOutput({ ...ok, stdout: `${"a".repeat(1000)}${"b".repeat(8000)}` }, 1, none);
    expect(out).toContain(`--- stdout\n… (1000 earlier characters cut)\n${"b".repeat(8000)}`);
    expect(out).not.toContain("aaa");
  });
  it("lists what changed in the room files, then each note", () => {
    const out = toolOutput(ok, 5, { written: ["a", "b"], deleted: ["c"], notes: ["n1", "n2"] });
    expect(out).toBe("exit 0 · 5 ms\nSaved to room files: a, b\nDeleted from room files: c\nn1\nn2");
    expect(toolOutput(ok, 5, { ...none, written: ["a"] }).endsWith("Saved to room files: a")).toBe(true);
  });
});
