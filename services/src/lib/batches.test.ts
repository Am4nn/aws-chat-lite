import { describe, expect, it } from "vitest";
import { bySize } from "./batches.js";

describe("bySize", () => {
  it("fills each batch up to the limit, and gives an item over it a batch of its own", () => {
    expect(bySize([3, 4, 2, 9, 1], (n) => n, 7)).toEqual([[3, 4], [2], [9], [1]]);
  });
  it("makes no batch from nothing", () => expect(bySize([], (n: number) => n, 7)).toEqual([]));
});
