import { describe, expect, it } from "vitest";
import { screenFiles } from "./uploads";

const file = (name: string, size: number) => ({ name, size });

describe("screenFiles", () => {
  it("refuses files over 10 MB by name", () => {
    const r = screenFiles([file("a.png", 10), file("big.mov", 10_485_761)], 0);
    expect(r.accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(r.errors).toEqual(["big.mov is over 10 MB."]);
  });
  it("keeps at most five per message, counting those already attached", () => {
    const r = screenFiles([file("1", 1), file("2", 1), file("3", 1)], 3);
    expect(r.accepted.map((f) => f.name)).toEqual(["1", "2"]);
    expect(r.errors).toEqual(["At most 5 files per message."]);
  });
});
