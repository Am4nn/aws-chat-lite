import { describe, expect, it } from "vitest";
import { removeOptimistically } from "./optimistic";

type Item = { id: string };
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));

/** A list held the way React state holds it: each change applies to the latest value. */
function holder(initial: Item[]) {
  const box = { list: initial };
  return { box, set: (change: (list: Item[]) => Item[]) => { box.list = change(box.list); } };
}

describe("removeOptimistically", () => {
  it("drops the item before the request answers", async () => {
    const { box, set } = holder(items("a", "b", "c"));
    let answer!: () => void;
    const done = removeOptimistically({ list: box.list, item: box.list[1], key: (x) => x.id, set }, () => new Promise<void>((r) => { answer = r; }));
    expect(box.list.map((x) => x.id)).toEqual(["a", "c"]);
    answer();
    await done;
    expect(box.list.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("puts the item back where it was when the request fails, and rethrows", async () => {
    const { box, set } = holder(items("a", "b", "c"));
    const refused = new Error("no");
    await expect(removeOptimistically({ list: box.list, item: box.list[1], key: (x) => x.id, set }, async () => { throw refused; })).rejects.toBe(refused);
    expect(box.list.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("doesn't add a second copy when a refetch already brought the item back", async () => {
    const { box, set } = holder(items("a", "b"));
    await expect(removeOptimistically({ list: box.list, item: box.list[0], key: (x) => x.id, set }, async () => {
      box.list = items("a", "b");
      throw new Error("no");
    })).rejects.toThrow();
    expect(box.list.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
