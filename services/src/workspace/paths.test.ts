import { describe, expect, it } from "vitest";
import { ValidationError } from "../lib/errors.js";
import { BAD_PATH, pathClash, workspacePath } from "./paths.js";

describe("workspacePath", () => {
  it.each(["a.txt", "data/2026 report (v2).csv", "it's 'x'.txt", "-notes.txt", "café/日本.md", "📄 notes.txt"])(
    "accepts %s", (p) => expect(workspacePath(p)).toBe(p),
  );

  it.each([
    "../x", "a/../../b", "/etc/passwd", String.raw`a\b`, "a\u0008", "a/./b", "x:y", " a", "a ", "a/ b", "", "a".repeat(201),
    "a/b/c/d/e/f/g/h/i", "a\u0000", "a//b", `it's "x".txt`, "x".repeat(101), 42, undefined,
    // A line break, a lone surrogate (a name that wasn't UTF-8), and invisible or direction-changing characters that
    // would make one name pass for another in the Files tab.
    "a\nb", "x\udcffy", "r‮txt.exe", "a​b", "a b", "a b", "­a",
  ])("rejects %j", (p) => {
    expect(() => workspacePath(p)).toThrow(ValidationError);
    expect(() => workspacePath(p)).toThrow(BAD_PATH);
  });

  it("allows 200 characters and 8 segments", () => {
    expect(workspacePath(["a", "b", "c", "d", "e", "f", "g", "h"].join("/"))).toBe("a/b/c/d/e/f/g/h");
    expect(workspacePath(`${"a".repeat(100)}/${"b".repeat(99)}`)).toHaveLength(200);
  });
});

describe("pathClash", () => {
  it("finds a folder where a file is wanted and the reverse", () => {
    expect(pathClash(["a/b.txt"], "a")).toBe("a/b.txt");
    expect(pathClash(["a"], "a/c")).toBe("a");
  });
  it("ignores shared prefixes that are not folders", () => expect(pathClash(["ab"], "a/c")).toBeNull());
});
