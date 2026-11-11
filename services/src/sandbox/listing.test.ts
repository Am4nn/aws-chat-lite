import { describe, expect, it } from "vitest";
import { SKIPPED_DIRS } from "../workspace/limits.js";
import { LIST_CODE, parseListing } from "./listing.js";

describe("parseListing", () => {
  it("reads the printed array", () => {
    const files = [{ path: "a/b.txt", size: 3, sha256: "abc" }];
    expect(parseListing(`${JSON.stringify(files)}\n`)).toEqual(files);
  });
  it("rejects anything else", () => {
    expect(() => parseListing("oops")).toThrow("Bad sandbox listing");
    expect(() => parseListing('{"a":1}')).toThrow("Bad sandbox listing");
  });
});

describe("LIST_CODE", () => {
  it("prunes the skipped folders and never follows links", () => {
    expect(LIST_CODE).toContain(JSON.stringify(SKIPPED_DIRS));
    expect(LIST_CODE).toContain("followlinks=False");
    expect(LIST_CODE).toContain("os.path.islink");
  });
});
