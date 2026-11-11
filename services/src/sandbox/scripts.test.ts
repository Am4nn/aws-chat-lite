import { describe, expect, it } from "vitest";
import { SKIPPED_DIRS } from "../workspace/limits.js";
import { LIST_CODE, parseListing, removeCode } from "./scripts.js";

const empty = { files: [], unreadable: [], badNames: [], more: 0 };

describe("parseListing", () => {
  it("reads the printed listing", () => {
    const listing = { ...empty, files: [{ path: "a/b.txt", size: 3, sha256: "abc" }], unreadable: ["locked"], more: 2 };
    expect(parseListing(`${JSON.stringify(listing)}\n`)).toEqual(listing);
  });
  it("rejects anything else", () => {
    for (const bad of ["oops", "[]", '{"files":[]}', JSON.stringify({ ...empty, more: "2" })]) {
      expect(() => parseListing(bad)).toThrow("Bad sandbox listing");
    }
  });
});

describe("LIST_CODE", () => {
  it("runs Python in isolated mode, so nothing in the working directory or the user's site can stand in for its imports", () => {
    expect(LIST_CODE).toMatch(/^exec python3 -I - <<'EOF'\n/);
    expect(LIST_CODE.endsWith("\nEOF\n")).toBe(true);
  });
  it("prunes the skipped folders and never follows links", () => {
    expect(LIST_CODE).toContain(JSON.stringify(SKIPPED_DIRS));
    expect(LIST_CODE).toContain("followlinks=False");
    expect(LIST_CODE).toContain("S_ISREG");
  });
});

describe("removeCode", () => {
  it("carries the paths as base64, so no path is ever quoted for the shell", () => {
    const code = removeCode(["it's $(x)", "a/b"]);
    expect(code).not.toContain("it's");
    const b64 = code.match(/printf %s ([A-Za-z0-9+/=]+) \|/)![1]!;
    expect(Buffer.from(b64, "base64").toString()).toBe("it's $(x)\na/b\n");
  });
});
